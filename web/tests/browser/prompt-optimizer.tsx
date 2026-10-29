import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import type { PromptOptimizationScenario } from "../../src/lib/prompt-optimization";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";

if (!import.meta.env.DEV || location.origin !== "http://127.0.0.1:3001") throw new Error("仅允许在独立端口 3001 的开发服务运行验收页");

const { usePromptOptimizer } = await import("../../src/hooks/use-prompt-optimizer");
const { InfiniteCanvas } = await import("../../src/components/canvas/infinite-canvas");
const { buildPromptOptimizationContext, buildPromptOptimizationGenerationIdentity, promptOptimizationTokens } = await import("../../src/lib/prompt-optimization");
const { defaultConfig, useConfigStore } = await import("../../src/stores/use-config-store");
const { useThemeStore } = await import("../../src/stores/use-theme-store");
const { getAntThemeConfig } = await import("../../src/lib/app-theme");
const { default: i18n } = await import("../../src/i18n");
await i18n.changeLanguage("zh-CN");

const textModels = ["fixture::gpt-6.1-sol", "fixture::text-model-b"];
useConfigStore.setState({ config: { ...defaultConfig, ...useConfigStore.getState().config, textModel: textModels[0], imageModel: "fixture::image-model", videoModel: "fixture::video-model", channels: [{ id: "fixture", name: "本地模拟文本渠道", baseUrl: "https://prompt-fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", models: [{ name: "gpt-6.1-sol", capability: "text" }, { name: "text-model-b", capability: "text" }, { name: "image-model", capability: "image" }, { name: "video-model", capability: "video" }] }], proxyEnabled: false } });

type Attempt = { id: number; model: string; scenario: string; source: string; requirements: string; aborted: boolean; closed: boolean; controller?: ReadableStreamDefaultController<Uint8Array>; cleanup?: () => void };
const requests: Attempt[] = [];
const originalFetch = window.fetch.bind(window);
let notify = () => {};
window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === location.origin) return originalFetch(input, init);
    if (url.origin !== "https://prompt-fixture.invalid" || !url.pathname.endsWith("/responses")) throw new Error("验收页禁止真实外部请求");
    const body = await request.json();
    const user = body.input.find((item: { role: string }) => item.role === "user");
    const context = JSON.parse(user.content.find((part: { type: string }) => part.type === "input_text").text);
    const attempt: Attempt = { id: requests.length + 1, model: body.model, scenario: context.scenario, source: context.sourcePrompt, requirements: context.additionalRequirements || "", aborted: request.signal.aborted, closed: false };
    const onAbort = () => { attempt.aborted = true; notify(); };
    request.signal.addEventListener("abort", onAbort);
    attempt.cleanup = () => request.signal.removeEventListener("abort", onAbort);
    requests.push(attempt);
    // Ignore abort deliberately: controls can deliver a late response to the real session guard.
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { attempt.controller = controller; },
        cancel() { attempt.closed = true; attempt.controller = undefined; attempt.cleanup?.(); notify(); },
    });
    notify();
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
};

function respond(attempt: Attempt | undefined, kind: "delta" | "complete" | "fail" | "eof", text: string) {
    if (!attempt?.controller || attempt.closed) return;
    const event = kind === "delta" ? { type: "response.output_text.delta", delta: text }
        : kind === "complete" ? { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] } }
        : { type: "response.failed", response: { status: "failed", error: { message: "本地模拟：优化失败" }, output: [] } };
    if (kind !== "eof") attempt.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    if (kind !== "delta") { attempt.controller.close(); attempt.closed = true; attempt.controller = undefined; attempt.cleanup?.(); }
    notify();
}

function Editor({ source, scenario, onApply }: { source: string; scenario: PromptOptimizationScenario; onApply: (value: string) => void }) {
    const config = useConfigStore((state) => state.config);
    const { openOptimizer, optimizerDialog } = usePromptOptimizer({
        getInput: () => {
            const generation = { ...config, model: scenario === "image" ? config.imageModel : config.videoModel };
            return { targetId: `fixture:${scenario}`, scenario, prompt: source, references: [], generationIdentity: buildPromptOptimizationGenerationIdentity(scenario, generation), context: { ...buildPromptOptimizationContext(scenario, generation, []), referenceTokens: promptOptimizationTokens(source).map((token, index) => ({ token, label: `引用${index + 1}` })) } };
        },
        onApply,
    });
    return <><button onClick={openOptimizer}>打开优化弹窗</button>{optimizerDialog}</>;
}

function Harness() {
    const [mounted, setMounted] = useState(true);
    const [source, setSource] = useState("一只小猫自然地向前奔跑");
    const [scenario, setScenario] = useState<PromptOptimizationScenario>("image");
    const [applied, setApplied] = useState<string[]>([]);
    const [responseText, setResponseText] = useState("一只小猫自然地向前奔跑，保持主体外观和空间关系一致。");
    const [selected, setSelected] = useState("");
    const [expanded, setExpanded] = useState(true);
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const [toolbarClicks, setToolbarClicks] = useState(0);
    const [keyboard, setKeyboard] = useState("尚无按键");
    const [cursor, setCursor] = useState("默认");
    const [, render] = useState(0);
    const canvas = useRef<HTMLDivElement>(null);
    const theme = useThemeStore((state) => state.theme);
    const model = useConfigStore((state) => state.config.textModel);
    const target = selected ? requests.find((request) => request.id === Number(selected)) : [...requests].reverse().find((request) => !request.closed);
    useEffect(() => { notify = () => render((value) => value + 1); return () => { notify = () => {}; }; }, []);
    useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
    useEffect(() => {
        const element = canvas.current;
        if (!element) return;
        const observer = new MutationObserver(() => setCursor(element.style.cursor || "默认"));
        observer.observe(element, { attributes: true, attributeFilter: ["style"] });
        const inspect = (event: KeyboardEvent) => { queueMicrotask(() => setKeyboard(`${event.type} ${event.code || event.key}；defaultPrevented=${event.defaultPrevented}`)); };
        window.addEventListener("keydown", inspect);
        window.addEventListener("keyup", inspect);
        return () => { observer.disconnect(); window.removeEventListener("keydown", inspect); window.removeEventListener("keyup", inspect); };
    }, []);
    return <ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App>
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)} data-canvas-shortcuts-ignore className="fixed inset-x-0 top-0 z-[2000] max-h-[36vh] overflow-auto border-b bg-white p-2 text-sm text-black dark:bg-stone-950 dark:text-white">
            <summary className="cursor-pointer font-semibold">提示词隔离验收控制栏（展开 / 收起）· 所有响应均为本地模拟</summary>
            <div className="flex flex-wrap items-center gap-3 py-2">
                {mounted ? <Editor source={source} scenario={scenario} onApply={(value) => { setApplied((items) => [...items, value]); setSource(value); }} /> : null}
                <button onClick={() => setMounted((value) => !value)}>{mounted ? "卸载编辑器" : "挂载编辑器"}</button>
                <button onClick={() => setSource("")}>切换空草稿</button>
                <button onClick={() => setSource("根据 @[node:fixture-subject] 的主体，使用 @[node:fixture-style] 的配色")}>切换含 token 草稿</button>
                <button onClick={() => setSource((value) => value + "（外部来源更新）")}>改变外部来源</button>
                <label>场景 <select aria-label="验收场景" value={scenario} onChange={(event) => setScenario(event.target.value as PromptOptimizationScenario)}><option value="image">图片</option><option value="video">视频</option></select></label>
                <button onClick={() => useConfigStore.getState().updateConfig("textModel", model === textModels[0] ? textModels[1] : textModels[0])}>外部切换文本模型</button>
                <button onClick={() => useThemeStore.getState().setTheme(theme === "dark" ? "light" : "dark")}>切换主题</button>
                <button onClick={() => location.reload()}>刷新验收页</button>
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-2">
                <label>响应目标 <select aria-label="模拟响应目标" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">最新挂起请求</option>{requests.map((request) => <option key={request.id} value={request.id}>请求 {request.id}{request.aborted ? " · 已取消" : ""}{request.closed ? " · 已结束" : ""}</option>)}</select></label>
                <button onClick={() => setResponseText(target?.source || source)}>使用请求草稿作结果</button>
                <button onClick={() => respond(target, "delta", responseText)}>发送片段</button>
                <button onClick={() => respond(target, "complete", responseText)}>完成（也可释放迟到响应）</button>
                <button onClick={() => respond(target, "fail", responseText)}>模拟失败</button>
                <button onClick={() => respond(target, "eof", responseText)}>不完整 EOF</button>
                <label className="flex min-w-72 flex-1 items-center gap-2">模拟正文 <textarea aria-label="模拟返回正文" className="min-w-0 flex-1 rounded border p-1" rows={2} value={responseText} onChange={(event) => setResponseText(event.target.value)} /></label>
            </div>
            <output className="block whitespace-pre-wrap" data-testid="optimizer-fixture-state">{`请求 ${requests.length}；应用 ${applied.length}；挂起 ${requests.filter((request) => !request.closed).length}；当前 ${scenario} / ${model}\n源稿：${source || "（空）"}\n最后回填：${applied.at(-1) || "（无）"}\n${keyboard}；画布光标：${cursor}；普通工具栏点击：${toolbarClicks}`}</output>
            <details><summary>请求诊断（不包含密钥）</summary><pre data-testid="optimizer-fixture-requests">{JSON.stringify(requests.map(({ id, model, scenario, source, requirements, aborted, closed }) => ({ id, model, scenario, source, requirements, aborted, closed })), null, 2)}</pre></details>
        </details>
        <div className="h-screen pt-14">
            <button className="relative z-10 m-3 rounded border px-3 py-2" onClick={() => setToolbarClicks((value) => value + 1)}>普通画布工具栏按钮</button>
            <div className="h-[70vh]"><InfiniteCanvas containerRef={canvas} viewport={viewport} tool="select" onViewportChange={setViewport}><div className="p-12">实际 InfiniteCanvas：空格 / Control 应临时切换工具，弹窗内不应切换。</div></InfiniteCanvas></div>
        </div>
    </App></ConfigProvider>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
import.meta.hot?.dispose(() => { root.unmount(); window.fetch = originalFetch; requests.forEach((request) => respond(request, "eof", "")); });
