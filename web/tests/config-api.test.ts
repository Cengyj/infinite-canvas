import "./setup";
import { expect, test } from "bun:test";
import axios from "axios";

import { requestImageQuestion, resolveGeminiImageGenerationConfig, resolveImagePluginRequestSize, resolveImagePluginSizeParams } from "../src/services/api/image";
import { getPluginTemplates, runModelPlugin } from "../src/services/api/model-plugin";
import { canFallbackToPublicVideoUrl, parseDataUrlInline, pollVideoGenerationTask } from "../src/services/api/video";
import { buildApiUrl, normalizeAiConfig, upsertChannelCredentials, useConfigStore, type AiConfig } from "../src/stores/use-config-store";

async function runGeminiImageTemplate(params: Record<string, unknown>, model: string, images: string[] = []) {
    const script = getPluginTemplates().image[1].script;
    const requests: Array<{ data?: Record<string, unknown> }> = [];
    const runner = new Function(
        "prompt",
        "images",
        "videos",
        "audios",
        "messages",
        "params",
        "model",
        "baseUrl",
        "apiKey",
        "systemPrompt",
        "reasoningEffort",
        "http",
        "request",
        "poll",
        "sleep",
        "signal",
        "onDelta",
        `"use strict"; return (async () => {\n${script}\n})();`,
    ) as (...args: unknown[]) => Promise<unknown>;
    await runner(
        "prompt",
        images,
        [],
        [],
        [],
        params,
        model,
        "https://example.test",
        "test-key",
        "",
        "auto",
        { url: (path: string) => path },
        async (request: { data?: Record<string, unknown> }) => {
            requests.push(request);
            return { candidates: [] };
        },
        undefined,
        undefined,
        undefined,
        undefined,
    );
    return requests;
}

test("keeps fresh defaults separate from legacy flat config hydration", () => {
    const fresh = normalizeAiConfig();
    expect(fresh.channels.map((channel) => channel.id)).toEqual(["default", "google"]);
    expect(fresh.textModel).toBe("default::gpt-6-sol");
    expect(fresh.channels[0].models).toContainEqual({ name: "gpt-6-sol", capability: "text" });

    const legacy = normalizeAiConfig({
        baseUrl: "https://legacy.example/v1",
        apiKey: "legacy-key",
        apiFormat: "openai",
        model: "legacy-image",
        imageModel: "legacy-image",
        textModel: "legacy-text",
        models: ["legacy-image", "legacy-text"],
    } as Partial<AiConfig>);
    expect(legacy.channels).toHaveLength(1);
    expect(legacy.channels[0]).toMatchObject({ baseUrl: "https://legacy.example/v1", apiKey: "legacy-key" });
    expect(legacy.channels[0].models.map((model) => model.name)).toEqual(["legacy-image", "legacy-text"]);
    expect(legacy.imageModel).toBe("default::legacy-image");
});

test("does not restore defaults over an explicit or malformed channels field", () => {
    expect(normalizeAiConfig({ channels: [] }).channels).toEqual([]);
    expect(normalizeAiConfig({ channels: "broken" } as unknown as Partial<AiConfig>).channels).toEqual([]);
});

test("keeps explicitly configured channel credentials and custom scripts", () => {
    const channels: AiConfig["channels"] = [{ id: "custom", name: "Custom", baseUrl: "https://api.example.test?tenant=mine", apiKey: "custom-key", apiFormat: "gemini", models: [{ name: "custom-image", capability: "image", script: 'return await request({ url: "/custom", data: { extra: params.size } });' }] }];
    const config = normalizeAiConfig({ channels, imageModel: "custom::custom-image" });
    expect(config.channels).toEqual(channels);
    expect(config.models).toEqual(["custom::custom-image"]);
    expect(config.imageModel).toBe("custom::custom-image");
});

test("builds versioned API URLs without duplicating the configured version", () => {
    expect(buildApiUrl("https://api.example.test", "/images/generations")).toBe("https://api.example.test/v1/images/generations");
    expect(buildApiUrl("https://api.example.test/v1", "/images/generations")).toBe("https://api.example.test/v1/images/generations");
    expect(buildApiUrl("https://api.example.test/root?tenant=a", "/models", "v1beta")).toBe("https://api.example.test/root/v1beta/models?tenant=a");
});

test("channel imports preserve queries and only match API versions in the path", () => {
    const empty = normalizeAiConfig({ channels: [] });
    const imported = upsertChannelCredentials(empty, { baseUrl: "https://api.example.test/root/?tenant=team/&sig=a%20b~#ignored", apiKey: "new-key" });
    expect(imported.config.channels[0].baseUrl).toBe("https://api.example.test/root?tenant=team/&sig=a%20b~");
    const trailingSlash = upsertChannelCredentials(empty, { baseUrl: "https://api.example.test/root?tenant=team/" });
    expect(trailingSlash.config.channels[0].baseUrl).toBe("https://api.example.test/root?tenant=team/");

    const existing = upsertChannelCredentials(empty, { baseUrl: "https://api.example.test?route=", apiKey: "kept-key" }).config;
    const distinct = upsertChannelCredentials(existing, { baseUrl: "https://api.example.test?route=/v1", apiKey: "other-key" });
    expect(distinct.status).toBe("created");
    expect(distinct.config.channels).toHaveLength(2);
    expect(distinct.config.channels[0]).toEqual(existing.channels[0]);
    const matched = upsertChannelCredentials(imported.config, { baseUrl: "https://api.example.test/root/v1/?tenant=team/&sig=a%20b~", apiKey: "updated-key" });
    expect(matched.status).toBe("updated");
    expect(matched.config.channels).toHaveLength(1);
    expect(matched.config.channels[0]).toMatchObject({ id: imported.config.channels[0].id, apiKey: "updated-key" });
});

test("Veo polling resolves protocol-relative operations against the provider before routing", async () => {
    const originalAdapter = axios.defaults.adapter;
    const originalConfig = useConfigStore.getState().config;
    const requests: Array<{ url?: string; key?: unknown }> = [];
    const config = normalizeAiConfig({
        channels: [{ id: "google", name: "Google", baseUrl: "https://api.example.test", apiKey: "current-key", apiFormat: "gemini", models: [{ name: "veo-test", capability: "video" }] }],
        videoModel: "google::veo-test",
    });
    axios.defaults.adapter = async (request) => {
        requests.push({ url: request.url, key: request.headers.get("x-goog-api-key") });
        return { data: { done: false }, status: 200, statusText: "OK", headers: {}, config: request };
    };
    try {
        for (const proxyEnabled of [false, true]) {
            useConfigStore.setState({ config: { ...originalConfig, proxyEnabled, proxyUrl: "http://127.0.0.1:23210" } });
            const task = { provider: "gemini" as const, model: "google::veo-test", id: "//api.example.test/v1beta/operations/id?key=stale-key&tenant=mine" };
            expect(await pollVideoGenerationTask(config, task)).toEqual({ status: "pending" });
            const prefix = proxyEnabled ? "http://127.0.0.1:23210/" : "";
            expect(requests.at(-1)).toEqual({ url: prefix + "https://api.example.test/v1beta/operations/id?tenant=mine", key: "current-key" });
            const count = requests.length;
            await expect(pollVideoGenerationTask(config, { ...task, id: "//other.example.test/operations/id" })).rejects.toThrow("different host");
            expect(requests).toHaveLength(count);
        }
    } finally {
        axios.defaults.adapter = originalAdapter;
        useConfigStore.setState({ config: originalConfig });
    }
});

test("Veo template downloads relative results from the provider and preserves signed CDN URLs", async () => {
    const originalAdapter = axios.defaults.adapter;
    const originalConfig = useConfigStore.getState().config;
    const requests: Array<{ url?: string; key?: unknown }> = [];
    const config = { ...originalConfig, model: "veo-test", baseUrl: "https://api.example.test", apiKey: "current-key" };
    const blob = new Blob(["video"], { type: "video/mp4" });
    let resultUrl = "";
    axios.defaults.adapter = async (request) => {
        requests.push({ url: request.url, key: request.headers.get("x-goog-api-key") });
        const data = request.method === "post" ? { name: "operations/id" }
            : request.responseType === "blob" ? blob
                : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: resultUrl } }] } } };
        return { data, status: 200, statusText: "OK", headers: {}, config: request };
    };
    try {
        for (const proxyEnabled of [false, true]) {
            useConfigStore.setState({ config: { ...originalConfig, proxyEnabled, proxyUrl: "http://127.0.0.1:23210" } });
            for (const uri of ["/v1beta/files/video:download?key=stale-key", "//api.example.test/v1beta/files/video:download?key=stale-key", "https://cdn.example.test/video.mp4?token=signed%2Bvalue&path=a%20b~"]) {
                resultUrl = uri;
                expect(await runModelPlugin({ capability: "video", config, script: getPluginTemplates().video[1].script, params: {} })).toBe(blob);
                const providerResult = !uri.startsWith("https://cdn.");
                const target = providerResult ? "https://api.example.test/v1beta/files/video:download" : uri;
                const prefix = proxyEnabled ? "http://127.0.0.1:23210/" : "";
                expect(requests.at(-1)).toEqual({ url: prefix + target, key: providerResult ? "current-key" : undefined });
            }
        }
    } finally {
        axios.defaults.adapter = originalAdapter;
        useConfigStore.setState({ config: originalConfig });
    }
});

test("Gemini streams preserve provider queries with and without the local proxy", async () => {
    const originalFetch = globalThis.fetch;
    const originalConfig = useConfigStore.getState().config;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"answer"}]},"finishReason":"STOP"}]}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const config = normalizeAiConfig({
        channels: [{ id: "google", name: "Google", baseUrl: "https://api.example.test/root/v1beta?tenant=a%2Fb&alt=json#ignored", apiKey: "test-key", apiFormat: "gemini", models: [{ name: "gemini-test", capability: "text" }] }],
        model: "google::gemini-test",
        textModel: "google::gemini-test",
    });
    try {
        for (const proxyEnabled of [false, true]) {
            useConfigStore.setState({ config: { ...originalConfig, proxyEnabled, proxyUrl: "http://127.0.0.1:23210" } });
            expect(await requestImageQuestion(config, [{ role: "user", content: "hello" }], () => {})).toBe("answer");
            const request = requests.at(-1)!;
            const prefix = proxyEnabled ? "http://127.0.0.1:23210/" : "";
            expect(request.startsWith(prefix + "https://api.example.test/")).toBe(true);
            const target = new URL(request.slice(prefix.length));
            expect(target.pathname).toBe("/root/v1beta/models/gemini-test:streamGenerateContent");
            expect(target.searchParams.get("tenant")).toBe("a/b");
            expect(target.searchParams.getAll("alt")).toEqual(["sse"]);
            expect(target.hash).toBe("");
        }
    } finally {
        globalThis.fetch = originalFetch;
        useConfigStore.setState({ config: originalConfig });
    }
});

test("custom fetch proxies Request inputs without losing method, body, headers or abort signal", async () => {
    const originalFetch = globalThis.fetch;
    const originalConfig = useConfigStore.getState().config;
    const controller = new AbortController();
    let captured: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = new Request(input, init);
        return new Response("ok");
    }) as typeof fetch;
    try {
        useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210" } });
        const result = await runModelPlugin({
            capability: "image",
            config: originalConfig,
            signal: controller.signal,
            script: 'return await (await fetch(new Request("https://api.example.test/custom?signature=a%2Bb", { method: "POST", headers: { "X-Custom": "kept" }, body: "payload", signal }), { headers: { "X-Custom": "override" } })).text();',
        });
        expect(result).toBe("ok");
        expect(captured?.url).toBe("http://127.0.0.1:23210/https://api.example.test/custom?signature=a%2Bb");
        expect(captured?.method).toBe("POST");
        expect(captured?.headers.get("X-Custom")).toBe("override");
        expect(await captured?.text()).toBe("payload");
        controller.abort();
        expect(captured?.signal.aborted).toBe(true);
    } finally {
        globalThis.fetch = originalFetch;
        useConfigStore.setState({ config: originalConfig });
    }
});

test("Veo template only falls back for direct cross-origin network failures and preserves CDN signatures", async () => {
    const cdnUrl = "https://cdn.example.test/video.mp4?token=signed%2Bvalue";
    const requests: Array<{ method: string; url: string; headers: Record<string, string>; data?: unknown }> = [];
    const runner = new Function("request", "poll", "http", "signal", "location", `return (async () => {
        const prompt = "video prompt", images = [], videos = [], audios = [];
        const params = { mode: "frames", seconds: "6", ratio: "16:9", resolution: "720p", generateAudio: true, watermark: false };
        const model = "veo-test", baseUrl = "https://api.example.test/root?tenant=mine", apiKey = "test-key";
        ${getPluginTemplates().video[1].script}
    })();`);
    const run = (error: unknown, proxied = false, signal?: AbortSignal, url = cdnUrl) => runner(
        async (request: typeof requests[number]) => {
            requests.push(request);
            if (request.method === "post") return { name: "operations/test" };
            throw error;
        },
        async () => ({ url }),
        { url: (value: string) => proxied ? `http://127.0.0.1:23210/${value}` : value },
        signal,
        { origin: "https://canvas.example.test" },
    );
    const networkError = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    expect(await run(networkError)).toEqual({ url: cdnUrl });
    expect(requests[0].url).toBe("https://api.example.test/root/v1beta/models/veo-test:predictLongRunning?tenant=mine");
    expect(requests[0].data).toEqual({ instances: [{ prompt: "video prompt" }], parameters: { aspectRatio: "16:9", durationSeconds: 6, resolution: "720p", generateAudio: true, addWatermark: false } });
    expect(requests[1]).toMatchObject({ url: cdnUrl, headers: {} });
    await expect(run(Object.assign(new Error("HTTP 403"), { code: "ERR_BAD_REQUEST" }))).rejects.toThrow("HTTP 403");
    await expect(run(new DOMException("Aborted", "AbortError"))).rejects.toThrow("Aborted");
    await expect(run(networkError, true)).rejects.toThrow("Network Error");
    const aborted = new AbortController();
    aborted.abort();
    await expect(run(networkError, false, aborted.signal)).rejects.toThrow("Network Error");
    await expect(run(networkError, false, undefined, "https://api.example.test/video.mp4?key=old-key")).rejects.toThrow("Network Error");
    expect(requests.at(-1)).toMatchObject({ url: "https://api.example.test/video.mp4", headers: { "x-goog-api-key": "test-key" } });
});

test("uses Gemini REST inlineData objects for Veo media", () => {
    expect(parseDataUrlInline("data:image/png;base64,AAAA")).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
});

test("only unauthenticated public video URLs may survive a failed download", () => {
    expect(canFallbackToPublicVideoUrl("https://cdn.example.test/video.mp4")).toBe(true);
    expect(canFallbackToPublicVideoUrl("https://cdn.example.test/video.mp4", { "x-goog-api-key": "secret" })).toBe(false);
    expect(canFallbackToPublicVideoUrl("blob:local-video")).toBe(false);
});

test("keeps Gemini image model capabilities in native and scripted requests", () => {
    const config = { ...normalizeAiConfig(), apiFormat: "gemini" as const, model: "gemini-3.1-flash-image-preview", quality: "auto" };
    expect(resolveGeminiImageGenerationConfig({ ...config, size: "2880x2880" })).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "4K" } });
    expect(resolveImagePluginRequestSize({ ...config, size: "1:4" })).toBe("1:4");
    expect(resolveImagePluginRequestSize({ ...config, size: "1:8" })).toBe("1:8");
    expect(resolveImagePluginRequestSize({ ...config, size: "16:9" })).toBe("1536x864");
    const pluginSizes = resolveImagePluginSizeParams({ ...config, size: "16:9" });
    expect(pluginSizes.size).toBe("1536x864");
    expect(pluginSizes.requestedSize).toBe("16:9");
    expect({ ...pluginSizes }).toEqual({ size: "1536x864" });
    expect(JSON.parse(JSON.stringify(pluginSizes))).toEqual({ size: "1536x864" });
    expect(resolveImagePluginRequestSize({ ...config, size: "512x512" })).toBe("512x512");
    expect(resolveImagePluginRequestSize({ ...config, size: "512x2048" })).toBe("512x2048");
    expect(() => resolveGeminiImageGenerationConfig({ ...config, model: "gemini-3.1-flash-lite-image-preview", size: "2048x2048" })).toThrow();
    expect(() => resolveGeminiImageGenerationConfig({ ...config, model: "gemini-3-pro-image-preview", size: "512x512" })).toThrow();
    expect(resolveGeminiImageGenerationConfig({ ...config, model: "gemini-2.5-flash-image-preview", size: "2048x2048" })).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } });

    const openAiConfig = { ...normalizeAiConfig(), apiFormat: "openai" as const, size: "16:9", quality: "auto" };
    expect(resolveImagePluginRequestSize(openAiConfig)).toBe("1536x864");
    expect(() => resolveImagePluginRequestSize({ ...openAiConfig, size: "512x512" })).toThrow();
});

test("Gemini image template submits camelCase media and exact preset sizes", async () => {
    const [request] = await runGeminiImageTemplate({ size: "2880x2880", count: 1 }, "gemini-3.1-flash-image-preview", ["data:image/png;base64,AAAA"]);
    expect(request.data).toEqual({
        contents: [{ role: "user", parts: [{ text: "prompt" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "4K" } },
    });
    const [paddedPresetRequest] = await runGeminiImageTemplate({ size: "02880x02880", count: 1 }, "gemini-3.1-flash-image-preview");
    expect(paddedPresetRequest.data?.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "4K" } });
    const [autoRatioRequest] = await runGeminiImageTemplate({ size: "1536x864", requestedSize: "16:9", count: 1 }, "gemini-3.1-flash-image-preview");
    expect(autoRatioRequest.data?.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } });
    for (const size of ["1:4", "1:8"]) {
        const [extendedRatioRequest] = await runGeminiImageTemplate({ size, count: 1 }, "gemini-3.1-flash-image-preview");
        expect(extendedRatioRequest.data?.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: size } });
    }
    const [smallRequest] = await runGeminiImageTemplate({ size: "512x512", count: 1 }, "gemini-3.1-flash-image-preview");
    expect(smallRequest.data?.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "512" } });
    await expect(runGeminiImageTemplate({ size: "2048x2048", count: 1 }, "gemini-3.1-flash-lite-image-preview")).rejects.toThrow("does not support 2K");
    await expect(runGeminiImageTemplate({ size: "512x512", count: 1 }, "gemini-3-pro-image-preview")).rejects.toThrow("does not support 512");
    for (const model of ["gemini-2.5-flash-image-preview", "custom-gemini-image"]) {
        const [legacyRequest] = await runGeminiImageTemplate({ size: "2048x2048", count: 1 }, model);
        expect(legacyRequest.data?.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } });
    }
});

test("built-in templates use structured URL helpers and split GPT Image parameters", () => {
    const templates = Object.values(getPluginTemplates()).flat();
    expect(templates.every((template) => !template.script.includes("${baseUrl}/v1"))).toBe(true);
    for (const template of templates) {
        expect(() => new Function(`"use strict"; return (async () => {\n${template.script}\n})();`)).not.toThrow();
    }

    const openAiImage = getPluginTemplates().image[0].script;
    expect(openAiImage).toContain('url: http.url("/images/generations")');
    expect(openAiImage).toContain('isGptImage ? { output_format: "png" } : { response_format: "b64_json" }');
    expect(openAiImage).toContain("isGptImage && background");
});
