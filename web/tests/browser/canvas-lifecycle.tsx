import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import localforage from "localforage";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";

if (location.origin !== "http://127.0.0.1:3001") throw new Error("仅允许在独立端口 3001 运行验收页");

const { default: CanvasPage } = await import("../../src/pages/canvas/project");
const { defaultConfig, useConfigStore } = await import("../../src/stores/use-config-store");
const { useCanvasStore } = await import("../../src/stores/canvas/use-canvas-store");
const { useThemeStore } = await import("../../src/stores/use-theme-store");
const { useAgentStore } = await import("../../src/stores/use-agent-store");
const { getAntThemeConfig } = await import("../../src/lib/app-theme");
const { localForageStorage } = await import("../../src/lib/localforage-storage");
const { CanvasNodeType } = await import("../../src/types/canvas");
const { default: i18n } = await import("../../src/i18n");
await i18n.changeLanguage("zh-CN");
if (!useCanvasStore.getState().hydrated) await new Promise<void>((resolve) => {
    const unsubscribe = useCanvasStore.subscribe((state) => { if (state.hydrated) { unsubscribe(); resolve(); } });
});

const model = "fixture::grok-imagine-video-1.5";
useConfigStore.setState({ config: { ...defaultConfig, model, videoModel: model, size: "16:9", vquality: "720", videoSeconds: "6", channels: [{ id: "fixture", name: "隔离验收", baseUrl: "https://canvas-fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", models: [{ name: "grok-imagine-video-1.5", capability: "video" }] }], models: [model], proxyEnabled: false } });
useAgentStore.getState().disconnectAgent({ enabled: false, panelOpen: false, fragmentBootstrap: false });

type Fixture = { label: string; complete: boolean };
const tasks = new Map<string, Fixture>();
const requests: { method: string; path: string; aborted?: boolean }[] = [];
const diagnostics: string[] = [];
const releases: (() => void)[] = [];
let holdNextQuery = false;
let failNextQuery = false;
let notify = () => {};
const recordError = (...values: unknown[]) => { diagnostics.push(values.map((value) => value instanceof Error ? value.message : String(value)).join(" ")); notify(); };
const originalError = console.error.bind(console);
console.error = (...values) => { recordError(...values); originalError(...values); };
const onError = (event: ErrorEvent) => recordError(event.error || event.message);
const onRejection = (event: PromiseRejectionEvent) => recordError(event.reason);
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);

async function makeVideo(label: string, color: string) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const paint = canvas.getContext("2d")!;
    paint.fillStyle = color; paint.fillRect(0, 0, 320, 180);
    paint.fillStyle = "white"; paint.font = "26px sans-serif"; paint.fillText("Fixture " + label, 100, 100);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const video = await new Promise<Blob>((resolve) => {
        recorder.ondataavailable = (event) => chunks.push(event.data);
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        recorder.start();
        window.setTimeout(() => recorder.stop(), 150);
    });
    stream.getTracks().forEach((track) => track.stop());
    return video;
}
const [videoA, videoB] = await Promise.all([makeVideo("A", "#2563eb"), makeVideo("B", "#15803d")]);

for (const project of useCanvasStore.getState().projects) for (const node of project.nodes) {
    const id = node.metadata?.videoTaskId;
    if (id?.startsWith("canvas-fixture-")) tasks.set(id, { label: id.startsWith("canvas-fixture-b-") ? "B" : "A", complete: Boolean(node.metadata?.content) });
}
axios.defaults.adapter = async (config) => {
    const url = new URL(config.url!);
    if (url.origin !== "https://canvas-fixture.invalid") throw new Error(`禁止外部请求：${url.origin}`);
    const entry = { method: config.method || "get", path: url.pathname, aborted: Boolean(config.signal?.aborted) };
    requests.push(entry);
    const abort = () => { entry.aborted = true; notify(); };
    config.signal?.addEventListener?.("abort", abort, { once: true });
    notify();
    const response = (data: unknown) => ({ data, status: 200, statusText: "OK", headers: {}, config });
    try {
        if (config.method === "post") {
            const id = "canvas-fixture-created-" + tasks.size;
            tasks.set(id, { label: "A", complete: false });
            return response({ id, status: "queued" });
        }
        const path = url.pathname.split("/");
        const isContent = path.at(-1) === "content";
        const id = path.at(isContent ? -2 : -1)!;
        const task = tasks.get(id);
        if (!task) throw new Error("验收任务不存在");
        if (isContent) return response(task.label === "B" ? videoB : videoA);
        if (holdNextQuery) {
            holdNextQuery = false;
            await new Promise<void>((resolve) => { releases.push(resolve); notify(); });
        }
        if (failNextQuery) { failNextQuery = false; throw new Error("验收模拟：查询中断"); }
        return response({ id, status: task.complete ? "completed" : "queued" });
    } finally {
        config.signal?.removeEventListener?.("abort", abort);
    }
};

const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const readFixtureIds = (): { a?: string; b?: string } => JSON.parse(sessionStorage.getItem("canvas-lifecycle-fixtures") || "{}");

function Controls() {
    const navigate = useNavigate();
    const route = useLocation();
    const [ids, setIds] = useState(readFixtureIds);
    const [snapshot, setSnapshot] = useState("尚未读取");
    const [, render] = useState(0);
    useEffect(() => { notify = () => render((value) => value + 1); return () => { notify = () => {}; }; }, []);
    const seed = () => {
        const store = useCanvasStore.getState();
        const a = store.createProject("隔离验收 · 项目 A");
        const b = store.createProject("隔离验收 · 项目 B");
        for (const [id, label] of [[a, "A"], [b, "B"]]) {
            const taskId = `canvas-fixture-${label.toLowerCase()}-${id}`;
            tasks.set(taskId, { label, complete: false });
            store.updateProject(id, { nodes: [{ id: "fixture-shared-video-node", type: CanvasNodeType.Video, title: "项目 " + label + " 视频", position: { x: 120, y: 90 }, width: 320, height: 180, metadata: { prompt: "项目 " + label + " 的独立视频结果", status: "loading", videoTaskId: taskId, videoTaskProvider: "openai", model, size: "16:9", vquality: "720", seconds: "6", videoMode: "frames" } }], viewport: { x: 0, y: 0, k: 1 } });
        }
        sessionStorage.setItem("canvas-lifecycle-fixtures", JSON.stringify({ a, b }));
        setIds({ a, b });
        navigate("/canvas/" + a);
    };
    const inspect = async () => {
        const saved = await localForageStorage.getItem("infinite-canvas:canvas_store");
        const state = saved ? JSON.parse(saved).state : undefined;
        const summarize = (projects: ReturnType<typeof useCanvasStore.getState>["projects"] = []) => projects.filter((project) => project.id === ids.a || project.id === ids.b).map((project) => ({ id: project.id, title: project.title, nodes: project.nodes.map((node) => ({ id: node.id, title: node.title, metadata: node.metadata })) }));
        setSnapshot(JSON.stringify({ route: route.pathname, fixtures: ids, memoryProjects: summarize(useCanvasStore.getState().projects), persistedProjects: summarize(state?.projects), mediaKeys: await mediaStore.keys() }, null, 2));
    };
    return <div className="shrink-0 border-b bg-white p-3 text-sm text-black dark:bg-stone-950 dark:text-white" data-testid="canvas-fixture-controls">
        <strong>画布隔离验收 · 真实 CanvasPage / StrictMode · 本地合成视频</strong>
        <div className="flex flex-wrap gap-3 py-2">
            <button onClick={seed}>创建 A/B 隔离项目</button>
            <button disabled={!ids.a} onClick={() => navigate("/canvas/" + ids.a)}>切换项目 A</button>
            <button disabled={!ids.b} onClick={() => navigate("/canvas/" + ids.b)}>切换项目 B</button>
            <button onClick={() => navigate("/canvas")}>离开项目</button>
            <button onClick={() => navigate("/canvas/fixture-does-not-exist")}>打开不存在项目</button>
            <button onClick={() => { tasks.forEach((task) => { task.complete = true; }); notify(); }}>完成全部模拟视频</button>
            <button onClick={() => { holdNextQuery = true; notify(); }}>延迟下一次查询</button>
            <button onClick={() => { releases.splice(0).forEach((release) => release()); notify(); }}>释放延迟查询</button>
            <button onClick={() => { failNextQuery = true; notify(); }}>下次查询失败</button>
            <button onClick={() => void inspect()}>读取画布持久快照</button>
            <button onClick={() => location.reload()}>刷新验收页</button>
        </div>
        <output data-testid="canvas-fixture-counts">路由 {route.pathname}；创建 {requests.filter((request) => request.method === "post").length}；查询 {requests.filter((request) => request.method === "get" && !request.path.endsWith("/content")).length}；下载 {requests.filter((request) => request.path.endsWith("/content")).length}；取消 {requests.filter((request) => request.aborted).length}；等待释放 {releases.length}；错误 {diagnostics.length}</output>
        <details><summary>请求、错误与持久化诊断</summary><div className="max-h-56 overflow-auto"><pre data-testid="canvas-fixture-errors">{JSON.stringify(diagnostics, null, 2)}</pre><pre data-testid="canvas-fixture-requests">{JSON.stringify(requests, null, 2)}</pre><pre data-testid="canvas-fixture-snapshot">{snapshot}</pre></div></details>
    </div>;
}

function Harness() {
    const theme = useThemeStore((state) => state.theme);
    useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
    return <ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App><QueryClientProvider client={client}><HashRouter><div className="flex h-screen min-h-0 flex-col">
        <Controls />
        <div className="min-h-0 flex-1"><Routes>
            <Route path="/canvas/:id" element={<CanvasPage />} />
            <Route path="*" element={<p className="p-8">验收项目已卸载。使用上方按钮创建或进入项目；不存在的项目会回到此处。</p>} />
        </Routes></div>
    </div></HashRouter></QueryClientProvider></App></ConfigProvider>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
import.meta.hot?.dispose(() => {
    root.unmount();
    console.error = originalError;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
});
