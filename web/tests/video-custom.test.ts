import "./setup";
import { expect, spyOn, test } from "bun:test";
import axios, { type InternalAxiosRequestConfig } from "axios";

import { normalizeVideoFrameSize, normalizeVideoRatio, normalizeVideoSeconds } from "../src/lib/video-config";
import { createVideoGenerationTask, pollVideoGenerationTask, waitForVideoGenerationTask } from "../src/services/api/video";
import { getPluginTemplates, runModelPlugin } from "../src/services/api/model-plugin";
import { setMediaBlob } from "../src/services/file-storage";
import { normalizeAiConfig, useConfigStore, type AiConfig } from "../src/stores/use-config-store";
import type { ReferenceImage } from "../src/types/image";

const image = (id = "ref"): ReferenceImage => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "data:image/png;base64,AAAA" });
function videoConfig(model = "grok-imagine-video-1.5", overrides: Partial<AiConfig> = {}) {
    const config = normalizeAiConfig({
        channels: [{ id: "custom", name: "Custom", baseUrl: "https://provider.example.test/root?tenant=a%2Fb", apiKey: "test-key", apiFormat: "openai", models: [{ name: model, capability: "video" }] }],
        videoModel: `custom::${model}`, size: "9:16", videoSeconds: "1", vquality: "720", ...overrides,
    });
    return { ...config, model: config.videoModel, baseUrl: config.channels[0].baseUrl, apiKey: config.channels[0].apiKey };
}

async function withRequests<T>(respond: (request: InternalAxiosRequestConfig) => unknown, run: (requests: InternalAxiosRequestConfig[]) => Promise<T>) {
    const originalAdapter = axios.defaults.adapter;
    const originalConfig = useConfigStore.getState().config;
    const requests: InternalAxiosRequestConfig[] = [];
    axios.defaults.adapter = async (request) => {
        requests.push(request);
        return { data: await respond(request), status: 200, statusText: "OK", headers: {}, config: request };
    };
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: false } });
    try { return await run(requests); }
    finally { axios.defaults.adapter = originalAdapter; useConfigStore.setState({ config: originalConfig }); }
}

test("Grok uses only its JSON fields and keeps one-second portrait and multiple references", async () => {
    await withRequests(() => ({ code: 200, data: { task_id: 42 } }), async (requests) => {
        const config = videoConfig();
        expect(await createVideoGenerationTask(config, "portrait motion", [image("one"), image("two")])).toMatchObject({ id: "42", provider: "openai", model: config.model });
        const body = JSON.parse(requests[0].data);
        expect(body).toMatchObject({ model: "grok-imagine-video-1.5", seconds: "1", aspect_ratio: "9:16", resolution: "720p", reference_images: [image().dataUrl, image().dataUrl] });
        expect(Object.keys(body).sort()).toEqual(["model", "prompt", "seconds", "aspect_ratio", "resolution", "reference_images"].sort());
        expect(requests[0].url).toBe("https://provider.example.test/root/v1/videos?tenant=a%2Fb");
        expect(requests[0].headers.get("Content-Type")).toBe("application/json");
        await createVideoGenerationTask(videoConfig(undefined, { size: "480x854", vquality: "480", videoSeconds: "15" }), "prompt", [image()]);
        expect(JSON.parse(requests[1].data)).toMatchObject({ seconds: "15", aspect_ratio: "9:16", resolution: "480p", image: image().dataUrl });
        expect(JSON.parse(requests[1].data).reference_images).toBeUndefined();
    });
});

test("Grok rejects unsupported combinations before submitting but accepts seven images", async () => {
    await withRequests(() => ({ id: "task" }), async (requests) => {
        for (const overrides of [{ videoSeconds: "16" }, { videoSeconds: "1.5" }, { size: "21:9" }, { vquality: "2160" }, { vquality: "invalid" }]) {
            await expect(createVideoGenerationTask(videoConfig(undefined, overrides), "prompt")).rejects.toThrow();
        }
        await expect(createVideoGenerationTask(videoConfig("grok-imagine-video", { vquality: "1080" }), "prompt")).rejects.toThrow();
        await expect(createVideoGenerationTask(videoConfig(undefined, { vquality: "1080" }), "prompt", [image(), image()])).rejects.toThrow();
        await expect(createVideoGenerationTask(videoConfig(), "prompt", Array.from({ length: 8 }, (_, i) => image(String(i))))).rejects.toThrow();
        await expect(createVideoGenerationTask(videoConfig(), "prompt", [], { videos: [{ id: "v", name: "v.mp4", type: "video/mp4", url: "https://example.test/ref.mp4" }] })).rejects.toThrow();
        expect(requests).toHaveLength(0);
        await createVideoGenerationTask(videoConfig(), "prompt", Array.from({ length: 7 }, (_, i) => image(String(i))));
        expect(JSON.parse(requests[0].data).reference_images).toHaveLength(7);
        await createVideoGenerationTask(videoConfig(undefined, { vquality: "1080" }), "prompt", [image()]);
        expect(JSON.parse(requests[1].data).resolution).toBe("1080p");
    });
});

test("ordinary video keeps v0.19 frame and multi-reference fields", async () => {
    await withRequests(() => ({ id: "task" }), async (requests) => {
        await createVideoGenerationTask(videoConfig("other-video", { videoMode: "frames", videoSeconds: "8" }), "prompt", [image("first"), image("last")]);
        const frames = requests[0].data as FormData;
        expect(frames).toBeInstanceOf(FormData);
        expect(frames.get("mode")).toBe("frames");
        expect(frames.get("first_frame")).toBeInstanceOf(File);
        expect(frames.get("last_frame")).toBeInstanceOf(File);
        expect(frames.get("size")).toBe("720x1280");
        expect(frames.get("resolution_name")).toBe("720p");
        await createVideoGenerationTask(videoConfig("other-video", { videoSeconds: "8" }), "prompt", Array.from({ length: 8 }, (_, i) => image(String(i))));
        expect((requests[1].data as FormData).getAll("image[]")).toHaveLength(8);
        await setMediaBlob("video:custom-test", new Blob(["video"], { type: "video/mp4" }));
        await setMediaBlob("audio:custom-test", new Blob(["audio"], { type: "audio/mpeg" }));
        await createVideoGenerationTask(videoConfig("other-video"), "prompt", [], {
            videos: [{ id: "v", name: "v.mp4", type: "video/mp4", storageKey: "video:custom-test", url: "" }],
            audios: [{ id: "a", name: "a.mp3", type: "audio/mpeg", storageKey: "audio:custom-test", url: "" }],
        });
        expect((requests[2].data as FormData).get("video[]")).toBeInstanceOf(File);
        expect((requests[2].data as FormData).get("audio[]")).toBeInstanceOf(File);
    });
});

test("failed status wins over stale media links and propagates the provider failure", async () => {
    await withRequests(() => ({ status: " CANCELED ", video_url: "https://cdn.example.test/stale.mp4", fail_reason: "quota exhausted" }), async (requests) => {
        const config = videoConfig();
        const task = { id: "task/id", provider: "openai" as const, model: config.model };
        expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "failed", error: "quota exhausted" });
        await expect(waitForVideoGenerationTask(config, task)).rejects.toMatchObject({ name: "VideoTaskFailed", message: "quota exhausted" });
        expect(requests).toHaveLength(2);
        expect(requests[0].url).toContain("/videos/task%2Fid?");
    });
});

test("nested results preserve portrait dimensions and authenticate only provider content", async () => {
    let mediaUrl = "/root/v1/videos/task/content?signature=a%2Bb";
    const blob = new Blob(["video"], { type: "video/mp4" });
    await withRequests((request) => request.responseType === "blob" ? blob : { code: "200", data: { status: "succeeded", output: { download_url: mediaUrl, width: "720", height: 1280, aspect_ratio: "9:16" } } }, async (requests) => {
        const config = videoConfig();
        const task = { id: "task", provider: "openai" as const, model: config.model };
        expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "completed", result: { blob, width: 720, height: 1280, aspectRatio: "9:16", mimeType: "video/mp4" } });
        expect(requests.at(-1)?.url).toBe("https://provider.example.test/root/v1/videos/task/content?signature=a%2Bb");
        expect(requests.at(-1)?.headers.get("Authorization")).toBe("Bearer test-key");
        mediaUrl = "//cdn.example.test/out.mp4?token=signed%2Bvalue&path=a%20b~";
        await pollVideoGenerationTask(config, task);
        expect(requests.at(-1)?.url).toBe("https://cdn.example.test/out.mp4?token=signed%2Bvalue&path=a%20b~");
        expect(requests.at(-1)?.headers.get("Authorization")).toBeUndefined();
    });
});

test("completed/progress-only tasks reject empty and error-document downloads", async () => {
    let blob = new Blob([]);
    await withRequests((request) => request.responseType === "blob" ? blob : { data: { progress: "100%" } }, async () => {
        const config = videoConfig();
        const task = { id: "task", provider: "openai" as const, model: config.model };
        for (const value of [new Blob([]), new Blob(["<html>bad gateway</html>"], { type: "text/html" }), new Blob(['{"error_message":"download denied"}'], { type: "application/json" })]) {
            blob = value;
            await expect(pollVideoGenerationTask(config, task)).rejects.toThrow();
        }
    });
});

test("abort identity survives generation submission and polling", async () => {
    const controller = new AbortController();
    await withRequests(() => { controller.abort(); return { id: "task" }; }, async (requests) => {
        await expect(createVideoGenerationTask(videoConfig(), "prompt", [], { signal: controller.signal })).rejects.toMatchObject({ name: "CanceledError" });
        await expect(pollVideoGenerationTask(videoConfig(), { id: "task", model: videoConfig().model, provider: "openai" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests).toHaveLength(1);
    });
});

test("download cancellation remains cancellation and never falls back to an external URL", async () => {
    const controller = new AbortController();
    await withRequests((request) => {
        if (request.responseType === "blob") {
            controller.abort();
            return new Blob(["video"], { type: "video/mp4" });
        }
        return { status: "completed", video_url: "https://cdn.example.test/video.mp4" };
    }, async (requests) => {
        const config = videoConfig();
        await expect(pollVideoGenerationTask(config, { id: "task", model: config.model, provider: "openai" }, { signal: controller.signal })).rejects.toMatchObject({ name: "CanceledError" });
        expect(requests).toHaveLength(2);
    });
});

test("video polling continues beyond five minutes and stops at the twenty-minute deadline", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
        now += ms;
        queueMicrotask(callback);
        return 0;
    }) as typeof setTimeout);
    try {
        await withRequests(() => ({ status: "processing" }), async (requests) => {
            const config = videoConfig();
            await expect(waitForVideoGenerationTask(config, { id: "task", model: config.model, provider: "openai" })).rejects.toThrow();
            expect(now).toBe(20 * 60_000);
            expect(requests).toHaveLength(400);
        });
    } finally { clock.mockRestore(); timers.mockRestore(); }
});

test("Sora standard template uses standard fields without removing the expanded template", async () => {
    const templates = getPluginTemplates().video;
    const blob = new Blob(["video"], { type: "video/mp4" });
    await withRequests((request) => request.method === "post" ? { request_id: "task/id" } : request.responseType === "blob" ? blob : { status: "finished" }, async (requests) => {
        const config = { ...videoConfig("sora-2"), model: "sora-2" };
        expect(await runModelPlugin({ capability: "video", config, script: templates[2].script, prompt: "prompt", images: [image().dataUrl], params: { seconds: "8", size: "720x1280" } })).toBe(blob);
        const body = requests[0].data as FormData;
        expect([...body.keys()].sort()).toEqual(["model", "prompt", "seconds", "size", "input_reference"].sort());
        expect(requests[1].url).toContain("/videos/task%2Fid?");
        await runModelPlugin({ capability: "video", config, script: templates[0].script, images: [image().dataUrl, image().dataUrl], params: { mode: "frames", seconds: "8", size: "720x1280" } });
        expect((requests[3].data as FormData).get("first_frame")).toBeInstanceOf(File);
        expect((requests[3].data as FormData).get("last_frame")).toBeInstanceOf(File);
    });
});

test("text templates send reference images and reject incomplete or blocked answers", async () => {
    let response: unknown = { status: "completed", output_text: "optimized" };
    await withRequests(() => response, async (requests) => {
        const args = { capability: "text" as const, config: videoConfig(), messages: [{ role: "system", content: "first" }, { role: "system", content: "second" }, { role: "user", content: [{ type: "text", text: "optimize" }, { type: "image_url", image_url: { url: image().dataUrl } }] }] };
        expect(await runModelPlugin({ ...args, script: getPluginTemplates().text[0].script })).toBe("optimized");
        expect(JSON.parse(requests[0].data).input[2].content[1]).toEqual({ type: "input_image", image_url: image().dataUrl });
        response = { status: "incomplete", output_text: "partial", incomplete_details: { reason: "max_output_tokens" } };
        await expect(runModelPlugin({ ...args, script: getPluginTemplates().text[0].script })).rejects.toThrow();
        response = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "private thought", thought: true }, { text: "optimized" }] } }] };
        expect(await runModelPlugin({ ...args, script: getPluginTemplates().text[1].script })).toBe("optimized");
        const geminiBody = JSON.parse(requests.at(-1)!.data);
        expect(geminiBody.contents[0].parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
        expect(geminiBody.systemInstruction.parts[0].text).toBe("first\n\nsecond");
        response = { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }] };
        await expect(runModelPlugin({ ...args, script: getPluginTemplates().text[1].script })).rejects.toThrow();
    });
});

test("shared video normalization preserves portrait ratios and model-specific seconds", () => {
    expect(normalizeVideoRatio("720x1280")).toBe("9:16");
    expect(normalizeVideoFrameSize("2:3", "1080p")).toBe("1080x1620");
    expect(normalizeVideoSeconds("2", "custom::grok-imagine-video-1.5")).toBe("2");
    expect(normalizeVideoSeconds("2", "custom::other-video")).toBe("4");
});

test("plugin HTTP helpers honor explicit API versions and preserve provider query signatures", async () => {
    await withRequests(() => ({}), async (requests) => {
        const config = { ...videoConfig(), baseUrl: "https://provider.example.test/root/v1?tenant=a%2Fb&sig=a%20b~" };
        for (const proxyEnabled of [false, true]) {
            useConfigStore.setState({ config: { ...useConfigStore.getState().config, proxyEnabled, proxyUrl: "http://127.0.0.1:23210" } });
            await runModelPlugin({ capability: "text", config, script: 'return await http.get("/v1beta/models");' });
            expect(requests.at(-1)?.url).toBe((proxyEnabled ? "http://127.0.0.1:23210/" : "") + "https://provider.example.test/root/v1beta/models?tenant=a%2Fb&sig=a%20b~");
        }
    });
});
