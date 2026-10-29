import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import localforage from "localforage";
import "antd/dist/reset.css";
import "../../src/styles/globals.css";

// This harness writes only to its isolated origin and never calls a model provider.
if (location.origin !== "http://127.0.0.1:3001") throw new Error("仅允许在独立端口 3001 运行验收页");

const { default: VideoPage } = await import("../../src/pages/video");
const { defaultConfig, useConfigStore } = await import("../../src/stores/use-config-store");
const { useThemeStore } = await import("../../src/stores/use-theme-store");
const { useAssetStore } = await import("../../src/stores/use-asset-store");
const { getAntThemeConfig } = await import("../../src/lib/app-theme");
const { default: i18n } = await import("../../src/i18n");
await i18n.changeLanguage("zh-CN");
const models = [{ name: "grok-imagine-video-1.5", capability: "video" as const }];
useConfigStore.setState({ config: { ...defaultConfig, model: "fixture::grok-imagine-video-1.5", videoModel: "fixture::grok-imagine-video-1.5", channels: [{ id: "fixture", name: "隔离验收", baseUrl: "https://video-fixture.invalid", apiKey: "fixture-only", apiFormat: "openai", models }], models: models.map((model) => `fixture::${model.name}`), proxyEnabled: false } });

const tasks = new Map<string, { prompt: string; complete: boolean }>(JSON.parse(sessionStorage.getItem("video-fixture-tasks") || "[]"));
const saveTasks = () => sessionStorage.setItem("video-fixture-tasks", JSON.stringify([...tasks]));
const requests: { method: string; path: string; body?: unknown }[] = [];
let queryFailure = false;
let holdCreation = false;
let releaseCreation: (() => void) | undefined;
let notify = () => {};
const canvas = document.createElement("canvas");
canvas.width = 320; canvas.height = 180;
const paint = canvas.getContext("2d")!;
paint.fillStyle = "#2563eb"; paint.fillRect(0, 0, 320, 180);
paint.fillStyle = "white"; paint.font = "22px sans-serif"; paint.fillText("Local fixture", 88, 96);
const stream = canvas.captureStream(10);
const recorder = new MediaRecorder(stream);
const chunks: Blob[] = [];
const videoBlob = await new Promise<Blob>((resolve) => {
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    recorder.start();
    window.setTimeout(() => recorder.stop(), 150);
});
stream.getTracks().forEach((track) => track.stop());

axios.defaults.adapter = async (config) => {
    const url = new URL(config.url!);
    if (url.origin !== "https://video-fixture.invalid") throw new Error(`禁止外部请求：${url.origin}`);
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    requests.push({ method: config.method || "get", path: url.pathname, body });
    notify();
    const response = (data: unknown) => ({ data, status: 200, statusText: "OK", headers: {}, config });
    if (config.method === "post") {
        const id = `fixture-${tasks.size + 1}`;
        tasks.set(id, { prompt: body.prompt, complete: false });
        saveTasks();
        if (holdCreation) await new Promise<void>((resolve) => { releaseCreation = resolve; });
        notify();
        return response({ id, status: "queued" });
    }
    if (url.pathname.endsWith("/content")) return response(videoBlob);
    if (queryFailure) { queryFailure = false; throw new Error("验收模拟：查询中断"); }
    const task = tasks.get(url.pathname.split("/").pop()!);
    if (!task) throw new Error("验收任务不存在");
    return response({ id: url.pathname.split("/").pop(), status: task.complete ? "completed" : "queued" });
};

const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const mediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
    const [mounted, setMounted] = useState(true);
    const [, render] = useState(0);
    const [snapshot, setSnapshot] = useState("尚未读取");
    const theme = useThemeStore((state) => state.theme);
    useEffect(() => { notify = () => render((value) => value + 1); return () => { notify = () => {}; }; }, []);
    useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
    const inspect = async () => {
        const logs: unknown[] = [];
        await logStore.iterate((value) => { logs.push(value); });
        setSnapshot(JSON.stringify({ logs, assets: useAssetStore.getState().assets, mediaKeys: await mediaStore.keys() }, null, 2));
    };
    return <ConfigProvider theme={getAntThemeConfig(theme === "dark")}><App><QueryClientProvider client={client}><MemoryRouter>
        <div className="border-b p-3 text-sm" data-testid="fixture-controls">
            <strong>隔离验收 · 合成视频 · 不请求真实模型</strong>
            <div className="flex flex-wrap gap-3 py-2">
                <button onClick={() => setMounted((value) => !value)}>{mounted ? "离开工作台" : "返回工作台"}</button>
                <button onClick={() => { tasks.forEach((task) => { task.complete = true; }); saveTasks(); notify(); }}>完成全部模拟任务</button>
                <button onClick={() => { queryFailure = true; }}>下次查询失败</button>
                <button onClick={() => { holdCreation = !holdCreation; notify(); }}>{holdCreation ? "关闭延迟创建" : "开启延迟创建"}</button>
                <button onClick={() => { releaseCreation?.(); releaseCreation = undefined; }}>释放创建响应</button>
                <button onClick={() => useThemeStore.getState().setTheme(theme === "dark" ? "light" : "dark")}>切换主题</button>
                <button onClick={() => void inspect()}>读取持久化快照</button>
            </div>
            <output data-testid="fixture-counts">创建 {requests.filter((request) => request.method === "post").length}；查询 {requests.filter((request) => request.method === "get" && !request.path.endsWith("/content")).length}；下载 {requests.filter((request) => request.path.endsWith("/content")).length}</output>
            <details><summary>请求与持久化诊断</summary><pre data-testid="fixture-requests">{JSON.stringify(requests, null, 2)}</pre><pre data-testid="fixture-snapshot">{snapshot}</pre></details>
        </div>
        {mounted ? <VideoPage /> : <p className="p-8">工作台已卸载，可释放响应后再返回。</p>}
    </MemoryRouter></QueryClientProvider></App></ConfigProvider>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><Harness /></React.StrictMode>);
import.meta.hot?.dispose(() => root.unmount());
