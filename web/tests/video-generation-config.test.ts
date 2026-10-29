import { expect, spyOn, test } from "bun:test";
import axios from "axios";
import type { AiConfig, ApiCallFormat, ModelCapability } from "../src/stores/use-config-store";
import type { PromptOptimizationInput } from "../src/lib/prompt-optimization";
import type { ReferenceImage } from "../src/types/image";
import type { CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/lib/video-generation-config"), import("../src/stores/use-config-store"), import("../src/services/api/video"), import("../src/lib/prompt-optimization"), import("../src/lib/media-size"), import("../src/lib/canvas/canvas-generation-helpers"), import("../src/types/canvas")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ getGrokVideoModel, resolveVideoGenerationConfig, assertVideoGenerationConfig }, { defaultConfig }, { createVideoGenerationTask, pollVideoGenerationTask, waitForVideoGenerationTask }, { buildPromptOptimizationContext, buildPromptOptimizationGenerationIdentity, samePromptOptimizationInput }, { computeVideoSize, videoRatioOptions }, { buildGenerationConfig }, { CanvasNodeType }] = dependencies;

function config(model = "grok-imagine-video", options: { apiFormat?: ApiCallFormat; script?: string; capability?: ModelCapability } = {}): AiConfig {
    return {
        ...defaultConfig, model: `test::${model}`, videoModel: `test::${model}`, size: "16:9",
        channels: [{ id: "test", name: "Mock provider", baseUrl: "https://generation.example", apiKey: "test-only", apiFormat: options.apiFormat || "openai", models: [{ name: model, capability: options.capability || "video", script: options.script }] }],
    };
}
const references = (count: number): ReferenceImage[] => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `图片${index + 1}`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(String(index))}` }));
const fields = (value: AiConfig, count = 0) => resolveVideoGenerationConfig(value, { imageCount: count }).issues.map((issue) => issue.field);

test("Grok capabilities match exact configured video models and their selected channel", () => {
    expect(getGrokVideoModel(config())).toBe("classic");
    expect(getGrokVideoModel(config("grok-imagine-video-1.5"))).toBe("1.5");
    for (const value of [
        config("custom-grok-imagine-video"), config("grok-imagine-video-latest"),
        config("grok-imagine-video", { capability: "image" }),
        config("grok-imagine-video", { apiFormat: "gemini" }),
        config("grok-imagine-video", { script: "return 'custom';" }),
        { ...config(), model: "removed::grok-imagine-video" },
        { ...config(), model: defaultConfig.imageModel },
    ]) expect(getGrokVideoModel(value)).toBeNull();
    const selected = config();
    selected.channels.unshift({ ...selected.channels[0], id: "other", models: [{ name: "grok-imagine-video", capability: "video", script: "return 'custom';" }] });
    expect(getGrokVideoModel(selected)).toBe("classic");
    expect(getGrokVideoModel({ ...selected, model: "other::grok-imagine-video" })).toBeNull();
});

test("project defaults remain six seconds and 720p without mutating user configuration", () => {
    const initial = config();
    const before = structuredClone(initial);
    expect(resolveVideoGenerationConfig(initial, { imageCount: 0 })).toMatchObject({ grok: "classic", seconds: "6", resolution: "720", mode: "reference", issues: [] });
    expect(initial).toEqual(before);
});

test.each([
    ["grok-imagine-video", 0, 15, ["480", "720"]],
    ["grok-imagine-video", 1, 10, ["480", "720"]],
    ["grok-imagine-video", 7, 10, ["480", "720"]],
    ["grok-imagine-video-1.5", 0, 15, ["480", "720", "1080"]],
    ["grok-imagine-video-1.5", 1, 15, ["480", "720", "1080"]],
    ["grok-imagine-video-1.5", 2, 15, ["480", "720"]],
    ["grok-imagine-video-1.5", 7, 15, ["480", "720"]],
] as const)("%s with %s images exposes compatible duration and resolution", (model, imageCount, maxSeconds, resolutions) => {
    const initial = config(model);
    const resolved = resolveVideoGenerationConfig(initial, { imageCount });
    expect(resolved.limits).toMatchObject({ minSeconds: 1, maxSeconds, resolutions });
    for (const seconds of ["1", "3", String(maxSeconds)]) {
        expect(fields({ ...initial, videoSeconds: seconds }, imageCount)).toEqual([]);
        expect(resolveVideoGenerationConfig({ ...initial, videoSeconds: seconds }, { imageCount }).seconds).toBe(seconds);
    }
    expect(fields({ ...initial, videoSeconds: String(maxSeconds + 1) }, imageCount)).toContain("seconds");
    for (const resolution of ["480", "720", "1080"]) {
        expect(fields({ ...initial, vquality: resolution }, imageCount).includes("resolution")).toBe(!resolutions.some((allowed) => allowed === resolution));
    }
});

test("Grok accepts zero-to-seven images and rejects excess images for both models", () => {
    for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
        const initial = { ...config(model), videoMode: "reference" };
        for (const count of [0, 1, 7]) expect(fields(initial, count)).toEqual([]);
        for (const count of [8, 14]) expect(fields(initial, count)).toContain("images");
        expect(resolveVideoGenerationConfig(initial).issues).toEqual([]);
        expect(resolveVideoGenerationConfig(initial).limits).toMatchObject({ minImages: 0, maxImages: 7 });
    }
});

test("Grok ignores every legacy mode value without mutating saved configuration", () => {
    for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
        for (const imageCount of [0, 1, 7, 8]) {
            const expected = resolveVideoGenerationConfig(config(model), { imageCount });
            for (const videoMode of ["frames", "reference", "invalid", ""]) {
                const initial = { ...config(model), videoMode };
                const resolved = resolveVideoGenerationConfig(initial, { imageCount });
                expect(resolved).toEqual(expected);
                expect(resolved.mode).toBe("reference");
                expect(resolved.issues.map((issue) => issue.field)).not.toContain("mode");
                expect(initial.videoMode).toBe(videoMode);
            }
        }
    }
});

test("invalid raw values stay visible rather than being clamped into valid requests", () => {
    for (const seconds of ["", "0", "-1", "1.5", "16", "30", "Infinity", "invalid"]) {
        const initial = { ...config(), videoSeconds: seconds };
        expect(resolveVideoGenerationConfig(initial).seconds).toBe(seconds);
        expect(fields(initial)).toContain("seconds");
        expect(initial.videoSeconds).toBe(seconds);
    }
    for (const vquality of ["", "auto", "high", "2048"]) expect(fields({ ...config(), vquality })).toContain("resolution");
});

test("only fixed ratios and matching derived sizes are accepted for Grok", () => {
    for (const item of videoRatioOptions.filter((item) => item.value !== "auto")) {
        expect(fields({ ...config(), size: item.value })).toEqual([]);
        expect(fields({ ...config(), size: computeVideoSize("720", item.value) })).toEqual([]);
    }
    for (const size of ["auto", "1000x1000", "1920x1080", "0x720", "unknown"]) expect(fields({ ...config(), size })).toContain("size");
    expect(fields({ ...config("grok-imagine-video-1.5"), vquality: "1080", size: "1920x1080" })).toEqual([]);
});

test("ordinary Grok generation rejects uploaded video and audio without dropping media", () => {
    const media = { imageCount: 1, videoCount: 2, audioCount: 1 };
    expect(resolveVideoGenerationConfig(config(), media).issues.map((issue) => issue.field)).toEqual(["videos", "audios"]);
    expect(media).toEqual({ imageCount: 1, videoCount: 2, audioCount: 1 });
    expect(() => assertVideoGenerationConfig(config(), media)).toThrow();
});

test("scripts, other video models and Gemini keep their existing generic normalization", () => {
    for (const initial of [config("custom-video"), config("grok-imagine-video", { apiFormat: "gemini" }), config("grok-imagine-video", { script: "return 'custom';" })]) {
        const resolved = resolveVideoGenerationConfig({ ...initial, videoSeconds: "3", size: "auto", vquality: "2048" }, { imageCount: 3, videoCount: 1, audioCount: 1 });
        expect(resolved).toMatchObject({ grok: null, seconds: "4", mode: "reference", issues: [] });
        expect(resolved.limits).toMatchObject({ minSeconds: 4, maxSeconds: 30 });
    }
});

test("creation rejects invalid Grok inputs before media getters or transport are touched", async () => {
    let reads = 0;
    const guardedImage: ReferenceImage = { id: "unread", name: "unread.png", type: "image/png", dataUrl: "", get storageKey() { reads += 1; throw new Error("Image was read before validation"); } };
    const post = spyOn(axios, "post").mockImplementation(async () => { throw new Error("Unexpected transport"); });
    try {
        for (const initial of [
            { ...config(), videoSeconds: "16" },
            { ...config(), videoSeconds: "11" },
            { ...config(), vquality: "1080" },
            { ...config(), size: "auto" },
        ]) await expect(createVideoGenerationTask(initial, "缓慢旋转", [guardedImage])).rejects.toThrow();
        const multiReference1080 = { ...config("grok-imagine-video-1.5"), vquality: "1080", size: "1920x1080" };
        for (const count of [2, 7]) {
            expect(fields(multiReference1080, count)).toEqual(["resolution"]);
            await expect(createVideoGenerationTask(multiReference1080, "缓慢旋转", Array.from({ length: count }, () => guardedImage))).rejects.toThrow();
        }
        await expect(createVideoGenerationTask(config(), "缓慢旋转", Array.from({ length: 8 }, () => guardedImage))).rejects.toThrow();
        await expect(createVideoGenerationTask(config(), "缓慢旋转", [guardedImage], { videos: [{ id: "v", name: "clip", get url() { reads += 1; throw new Error("Video was read"); } }] })).rejects.toThrow();
        await expect(createVideoGenerationTask(config(), "缓慢旋转", [guardedImage], { audios: [{ id: "a", name: "sound", get url() { reads += 1; throw new Error("Audio was read"); } }] })).rejects.toThrow();
        expect(reads).toBe(0);
        expect(post).not.toHaveBeenCalled();
    } finally { post.mockRestore(); }
});

test.each(["1", "6", "15"])("Grok 1.5 accepts one ordinary 1080p reference for %s seconds with matching optimization context", async (seconds) => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        const initial = { ...config("grok-imagine-video-1.5"), videoSeconds: seconds, vquality: "1080", size: "1920x1080" };
        const before = structuredClone(initial);
        const images = references(1);
        await createVideoGenerationTask(initial, "保留主体并缓慢旋转", images);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1]).toEqual({ model: "grok-imagine-video-1.5", prompt: "保留主体并缓慢旋转", seconds, aspect_ratio: "16:9", resolution: "1080p", reference_images: [{ url: images[0].dataUrl }] });
        expect(buildPromptOptimizationContext("video", initial, images)).toMatchObject({ frameSize: "16:9", quality: "1080p", durationSeconds: seconds, imageRoles: ["reference-image"], referenceMode: "reference" });
        expect(initial).toEqual(before);
    } finally { post.mockRestore(); }
});

test("Grok 1.5 revalidates 1080p when reference counts change without rewriting settings", () => {
    const initial = { ...config("grok-imagine-video-1.5"), videoSeconds: "15", vquality: "1080", size: "1920x1080" };
    const before = structuredClone(initial);
    for (const count of [1, 2, 1]) {
        const resolved = resolveVideoGenerationConfig(initial, { imageCount: count });
        const context = buildPromptOptimizationContext("video", initial, references(count));
        expect(resolved.issues.map((issue) => issue.field)).toEqual(count === 2 ? ["resolution"] : []);
        expect(context.frameSize).toBe(count === 2 ? undefined : "16:9");
        expect(context.quality).toBe(count === 2 ? undefined : "1080p");
        expect(resolved).toMatchObject({ seconds: "15", resolution: "1080", size: "1920x1080" });
        expect(initial).toEqual(before);
    }
});

test("valid short Grok durations use only six JSON fields and forward the abort signal", async () => {
    const requests: Array<{ url: string; body: unknown; options: Parameters<typeof axios.post>[2] }> = [];
    const post = spyOn(axios, "post").mockImplementation(async (url, data, options) => { requests.push({ url, body: data, options }); return { data: { id: "mock-task" } } as never; });
    try {
        for (const [input, seconds] of [["1", "1"], ["3", "3"], ["3.0", "3"]]) {
            const initial = { ...config(), videoSeconds: input, vquality: input === "3.0" ? " 720P " : "720" };
            const images = references(1);
            const controller = new AbortController();
            const task = await createVideoGenerationTask(initial, "主体缓慢转身", images, { signal: controller.signal });
            const { url, body, options } = requests.at(-1)!;
            expect(task).toMatchObject({ provider: "openai", model: "test::grok-imagine-video" });
            expect(url).toBe("https://generation.example/v1/videos");
            expect(body).not.toBeInstanceOf(FormData);
            expect(body).toEqual({ model: "grok-imagine-video", prompt: "主体缓慢转身", seconds, aspect_ratio: "16:9", resolution: "720p", reference_images: images.map((image) => ({ url: image.dataUrl })) });
            expect(options?.headers).toMatchObject({ "Content-Type": "application/json" });
            expect(options?.signal).toBe(controller.signal);
            expect(buildPromptOptimizationContext("video", initial, images).durationSeconds).toBe(seconds);
            expect(initial.videoSeconds).toBe(input);
        }
    } finally { post.mockRestore(); }
});

test.each(["grok-imagine-video", "grok-imagine-video-1.5"])("%s sends an empty reference_images array for text-to-video and strips the channel prefix", async (model) => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        const task = await createVideoGenerationTask(config(model), "无参考视频");
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1]).toEqual({ model, prompt: "无参考视频", seconds: "6", aspect_ratio: "16:9", resolution: "720p", reference_images: [] });
        expect(post.mock.calls[0][2]?.headers).toMatchObject({ "Content-Type": "application/json" });
        expect(task.model).toBe(`test::${model}`);
    } finally { post.mockRestore(); }
});

test("Grok sends explicit resolution and aspect ratio while preserving default and stored sizes", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        for (const [model, size, vquality, aspectRatio] of [
            ["grok-imagine-video", defaultConfig.size, defaultConfig.vquality, "1:1"],
            ["grok-imagine-video", "9:16", "480", "9:16"],
            ["grok-imagine-video", "854x480", "480", "16:9"],
            ["grok-imagine-video", "1280x720", "720", "16:9"],
            ["grok-imagine-video-1.5", "1920x1080", "1080", "16:9"],
        ]) {
            const initial = { ...config(model), size, vquality };
            const before = structuredClone(initial);
            await createVideoGenerationTask(initial, "保持构图");
            expect(post.mock.calls.at(-1)![1]).toEqual({ model, prompt: "保持构图", seconds: "6", aspect_ratio: aspectRatio, resolution: `${vquality}p`, reference_images: [] });
            expect(buildPromptOptimizationContext("video", initial, [])).toMatchObject({ frameSize: aspectRatio, quality: `${vquality}p`, durationSeconds: "6" });
            expect(initial).toEqual(before);
        }
    } finally { post.mockRestore(); }
});

test("Grok JSON retains complete data URLs once per image in the selected order", async () => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
            for (const count of [1, 7]) {
                const images = references(count).reverse().map((image, index) => ({ ...image, type: index % 2 ? "image/jpeg" : "image/webp", dataUrl: image.dataUrl!.replace("image/png", index % 2 ? "image/jpeg" : "image/webp") }));
                const before = structuredClone(images);
                for (const videoMode of ["frames", "reference", "invalid"]) {
                    await createVideoGenerationTask({ ...config(model), videoMode }, "参考人物和场景", images);
                    expect(post.mock.calls.at(-1)![1]).toEqual({ model, prompt: "参考人物和场景", seconds: "6", aspect_ratio: "16:9", resolution: "720p", reference_images: images.map((image) => ({ url: image.dataUrl })) });
                }
                expect(images).toEqual(before);
            }
        }
        const images = references(2).reverse();
        await createVideoGenerationTask(config("grok-imagine-video-1.5"), "参考两张图片", images);
        expect(post.mock.calls.at(-1)![1]).toEqual({ model: "grok-imagine-video-1.5", prompt: "参考两张图片", seconds: "6", aspect_ratio: "16:9", resolution: "720p", reference_images: images.map((image) => ({ url: image.dataUrl })) });
    } finally { post.mockRestore(); }
});

test.each(["", "data:text/plain;base64,MA==", "data:image/png;base64,", "data:image/png,not-base64"])("Grok rejects unusable image data URLs before POST (%#)", async (dataUrl) => {
    const post = spyOn(axios, "post").mockImplementation(async () => { throw new Error("Unexpected transport"); });
    try {
        for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
            await expect(createVideoGenerationTask(config(model), "不要提交无效图片", [{ ...references(1)[0], dataUrl }])).rejects.toThrow();
        }
        expect(post).not.toHaveBeenCalled();
    } finally { post.mockRestore(); }
});

test("Grok never posts after its AbortSignal is already aborted", async () => {
    const post = spyOn(axios, "post").mockImplementation(async () => { throw new Error("Unexpected transport"); });
    try {
        const controller = new AbortController();
        controller.abort();
        for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
            for (const count of [0, 1]) {
                await expect(createVideoGenerationTask(config(model), "已经取消", references(count), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
            }
        }
        expect(post).not.toHaveBeenCalled();
    } finally { post.mockRestore(); }
});

test.each(["sora-2", "custom-video", "grok-imagine-video-latest"])("%s retains generic multipart fields and duplicate file aliases", async (model) => {
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        const controller = new AbortController();
        for (const mode of ["frames", "reference"]) {
            const count = mode === "frames" ? 2 : 3;
            await createVideoGenerationTask({ ...config(model), videoMode: mode }, "保留通用视频请求", references(count), { signal: controller.signal });
            const [url, body, options] = post.mock.calls.at(-1)!;
            expect(url).toBe("https://generation.example/v1/videos");
            expect(body).toBeInstanceOf(FormData);
            expect(options?.headers).not.toHaveProperty("Content-Type");
            expect(options?.signal).toBe(controller.signal);
            const form = body as FormData;
            for (const [field, expected] of Object.entries({ model, prompt: "保留通用视频请求", seconds: "6", size: "1280x720", ratio: "16:9", resolution_name: "720p", generate_audio: "true", watermark: "false", mode })) expect(form.get(field)).toBe(expected);
            expect(form.getAll("images")).toHaveLength(count);
            expect(await Promise.all(form.getAll("images").map((file) => (file as File).text()))).toEqual(Array.from({ length: count }, (_, index) => String(index)));
            if (mode === "frames") {
                expect(await (form.get("first_frame") as File).text()).toBe("0");
                expect(await (form.get("last_frame") as File).text()).toBe("1");
                expect(form.has("image[]")).toBe(false);
            } else {
                expect(await Promise.all(form.getAll("image[]").map((file) => (file as File).text()))).toEqual(["0", "1", "2"]);
                expect(form.has("first_frame")).toBe(false);
                expect(form.has("last_frame")).toBe(false);
            }
        }
    } finally { post.mockRestore(); }
});

test("request validation and serialization retain a selected channel's identity", async () => {
    const initial = { ...config(), videoSeconds: "3" };
    initial.channels.unshift({ ...initial.channels[0], id: "scripted", baseUrl: "https://script.example", models: [{ name: "grok-imagine-video", capability: "video", script: "return 'custom';" }] });
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        await expect(createVideoGenerationTask({ ...initial, videoSeconds: "30" }, "无参考视频")).rejects.toThrow();
        expect(post).not.toHaveBeenCalled();
        await createVideoGenerationTask(initial, "无参考视频");
        expect(post.mock.calls[0][1]).toMatchObject({ model: "grok-imagine-video", seconds: "3" });
        expect(post.mock.calls[0][0]).toBe("https://generation.example/v1/videos");
    } finally { post.mockRestore(); }
});

test("creation serializes the single validated parameter result without resolving it again", async () => {
    const initial = config();
    const validated = resolveVideoGenerationConfig({ ...initial, videoSeconds: "3", size: "9:16", vquality: "480" }, { imageCount: 1 });
    const validate = spyOn(dependencies[0], "assertVideoGenerationConfig").mockReturnValue(validated);
    const post = spyOn(axios, "post").mockResolvedValue({ data: { id: "mock-task" } } as never);
    try {
        await createVideoGenerationTask(initial, "复用已校验参数", references(1));
        expect(validate).toHaveBeenCalledTimes(1);
        expect(validate.mock.calls[0][0]).toMatchObject({ model: "test::grok-imagine-video", videoSeconds: "6", size: "16:9", vquality: "720" });
        expect(post.mock.calls[0][1]).toMatchObject({ model: "grok-imagine-video", seconds: "3", aspect_ratio: "9:16", resolution: "480p" });
    } finally { validate.mockRestore(); post.mockRestore(); }
});

test("a Grok name on a Gemini channel retains its own request protocol and generic parameters", async () => {
    const initial = { ...config("grok-imagine-video", { apiFormat: "gemini" }), videoSeconds: "3", vquality: "1080" };
    const images = references(3);
    const post = spyOn(axios, "post").mockResolvedValue({ data: { name: "operations/mock-task" } } as never);
    try {
        expect(await createVideoGenerationTask(initial, "保留 Gemini 协议", images)).toEqual({ id: "operations/mock-task", provider: "gemini", model: initial.model });
        expect(post.mock.calls[0][0]).toBe("https://generation.example/v1beta/models/grok-imagine-video:predictLongRunning");
        expect(post.mock.calls[0][1]).toEqual({
            instances: [{ prompt: "保留 Gemini 协议", referenceImages: images.map((image) => ({ image: { bytesBase64Encoded: image.dataUrl!.split(",")[1], mimeType: "image/png" }, referenceType: "asset" })) }],
            parameters: { aspectRatio: "16:9", durationSeconds: 4, resolution: "1080p", generateAudio: true, addWatermark: false },
        });
        expect(post.mock.calls[0][2]?.headers).toEqual({ "x-goog-api-key": "test-only", "Content-Type": "application/json" });
    } finally { post.mockRestore(); }
});

const genericParameterCases = [
    ["low quality and a short square clip", { videoSeconds: "3", vquality: "low", size: "1:1", videoMode: "frames" }, 2, { seconds: "4", resolution: "480p", size: "480x480", ratio: "1:1", mode: "frames" }],
    ["high quality and fractional portrait duration", { videoSeconds: "5.9", vquality: "high", size: "9:16", videoMode: "frames" }, 3, { seconds: "5", resolution: "720p", size: "720x1280", ratio: "9:16", mode: "reference" }],
    ["auto size and quality with an explicit reference mode", { videoSeconds: "", vquality: "auto", size: "auto", videoMode: "reference" }, 1, { seconds: "6", resolution: "720p", size: null, ratio: "16:9", mode: "reference" }],
    ["medium quality with a stored pixel size and upper duration bound", { videoSeconds: "31", vquality: "medium", size: "1920x1080", videoMode: "frames" }, 1, { seconds: "30", resolution: "720p", size: "1920x1080", ratio: "16:9", mode: "frames" }],
    ["an uppercase resolution suffix and zero duration fallback", { videoSeconds: "0", vquality: "1080P", size: "720x1280", videoMode: "frames" }, 2, { seconds: "6", resolution: "1080p", size: "720x1280", ratio: "9:16", mode: "frames" }],
    ["empty generic settings", { videoSeconds: "", vquality: "", size: "", videoMode: "" }, 0, { seconds: "6", resolution: "720p", size: "1280x720", ratio: "16:9", mode: "frames" }],
    ["custom settings outside built-in Grok limits", { videoSeconds: "16", vquality: "2048p", size: "2048x2048", videoMode: "frames" }, 8, { seconds: "16", resolution: "2048p", size: "2048x2048", ratio: "1:1", mode: "reference" }],
] as const;

test.each(genericParameterCases)("Gemini preserves %s without OpenAI parameter validation", async (_label, settings, count, expected) => {
    const initial = { ...config("grok-imagine-video", { apiFormat: "gemini" }), ...settings, videoGenerateAudio: "false", videoWatermark: "true" };
    const before = structuredClone(initial);
    const images = references(count);
    const inline = images.map((image) => ({ bytesBase64Encoded: image.dataUrl!.split(",")[1], mimeType: "image/png" }));
    const controller = new AbortController();
    const validate = spyOn(dependencies[0], "assertVideoGenerationConfig");
    const post = spyOn(axios, "post").mockResolvedValue({ data: { name: "operations/mock-task" } } as never);
    try {
        expect(await createVideoGenerationTask(initial, "保留通用参数", images, { signal: controller.signal })).toMatchObject({ provider: "gemini", model: initial.model });
        expect(post.mock.calls[0][1]).toEqual({
            instances: [{ prompt: "保留通用参数", ...(expected.mode === "reference"
                ? { referenceImages: inline.map((image) => ({ image, referenceType: "asset" })) }
                : { ...(inline[0] ? { image: inline[0] } : {}), ...(inline[1] ? { lastFrame: inline[1] } : {}) }) }],
            parameters: { aspectRatio: expected.ratio, durationSeconds: Number(expected.seconds), resolution: expected.resolution, generateAudio: false, addWatermark: true },
        });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][2]?.signal).toBe(controller.signal);
        expect(validate).not.toHaveBeenCalled();
        expect(initial).toEqual(before);
    } finally { validate.mockRestore(); post.mockRestore(); }
});

test.each(genericParameterCases)("saved video scripts preserve %s before built-in protocol selection", async (_label, settings, count, expected) => {
    const script = "return { url: 'mock:' + JSON.stringify({ params, images, prompt }) };";
    const images = references(count);
    const validate = spyOn(dependencies[0], "assertVideoGenerationConfig");
    const post = spyOn(axios, "post").mockImplementation(async () => { throw new Error("Unexpected built-in transport"); });
    try {
        for (const apiFormat of ["openai", "gemini"] as const) {
            const initial = { ...config("grok-imagine-video", { apiFormat, script }), ...settings, videoGenerateAudio: "false", videoWatermark: "true" };
            const before = structuredClone(initial);
            const task = await createVideoGenerationTask(initial, "用户脚本", images);
            expect(task).toMatchObject({ provider: "plugin", model: initial.model });
            const state = await pollVideoGenerationTask(initial, task);
            expect(state.status).toBe("completed");
            if (state.status === "completed") expect(JSON.parse(state.result.url!.slice(5))).toEqual({ params: { ...expected, generateAudio: false, watermark: true }, images: images.map((image) => image.dataUrl), prompt: "用户脚本" });
            expect(initial).toEqual(before);
        }
        expect(validate).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    } finally { validate.mockRestore(); post.mockRestore(); }
});

test.each(["openai", "gemini"] as const)("%s task requests preserve cancellation identity and ordinary error messages", async (apiFormat) => {
    const initial = config("grok-imagine-video", { apiFormat });
    const task = { id: "mock-task", provider: apiFormat, model: initial.model };
    const post = spyOn(axios, "post").mockRejectedValue(new axios.CanceledError("canceled"));
    const get = spyOn(axios, "get").mockRejectedValue(new axios.CanceledError("canceled"));
    try {
        await expect(createVideoGenerationTask(initial, "已取消")).rejects.toMatchObject({ name: "AbortError" });
        await expect(pollVideoGenerationTask(initial, task)).rejects.toMatchObject({ name: "AbortError" });
        const abort = new DOMException("cancel reason", "AbortError");
        post.mockRejectedValue(abort);
        get.mockRejectedValue(abort);
        await expect(createVideoGenerationTask(initial, "已取消")).rejects.toBe(abort);
        await expect(pollVideoGenerationTask(initial, task)).rejects.toBe(abort);
        const error = { isAxiosError: true, response: { status: 400, data: { error: { message: "渠道返回的明确错误" } } } };
        post.mockRejectedValue(error);
        get.mockRejectedValue(error);
        await expect(createVideoGenerationTask(initial, "失败")).rejects.toThrow("渠道返回的明确错误");
        await expect(pollVideoGenerationTask(initial, task)).rejects.toThrow("渠道返回的明确错误");
    } finally { post.mockRestore(); get.mockRestore(); }
});

test("a cancellation before the completed poll returns cannot publish its result", async () => {
    const initial = config();
    const controller = new AbortController();
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "mock-task", status: "completed" } } as never).mockImplementationOnce(async () => {
        controller.abort();
        return { data: new Blob(["video"], { type: "video/mp4" }) } as never;
    });
    try {
        await expect(waitForVideoGenerationTask(initial, { id: "mock-task", provider: "openai", model: initial.model }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(get).toHaveBeenCalledTimes(2);
    } finally { get.mockRestore(); }
});

test.each([false, true])("poll waits clean their abort listener when canceled=%s without changing the interval", async (cancel) => {
    const initial = config();
    const controller = new AbortController();
    const blob = new Blob(["video"], { type: "video/mp4" });
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "mock-task", status: "in_progress" } } as never).mockResolvedValueOnce({ data: { id: "mock-task", status: "completed" } } as never).mockResolvedValueOnce({ data: blob } as never);
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback) => { queueMicrotask(cancel ? () => controller.abort() : callback as () => void); return 0 as never; });
    try {
        const result = waitForVideoGenerationTask(initial, { id: "mock-task", provider: "openai", model: initial.model }, { signal: controller.signal });
        if (cancel) await expect(result).rejects.toMatchObject({ name: "AbortError" });
        else expect(await result).toEqual({ blob });
        expect(timer.mock.calls.map((call) => call[1])).toEqual([2500]);
        expect(added).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0][1]);
        expect(get).toHaveBeenCalledTimes(cancel ? 1 : 3);
    } finally { get.mockRestore(); added.mockRestore(); removed.mockRestore(); timer.mockRestore(); }
});

test("saved Grok scripts retain generic parameters and remain separate from built-in validation", async () => {
    const script = "return { url: 'mock:' + JSON.stringify(params) };";
    const initial = { ...config("grok-imagine-video", { script }), videoSeconds: "3", size: "auto", vquality: "1080" };
    const task = await createVideoGenerationTask(initial, "自定义脚本", references(3));
    expect(task.provider).toBe("plugin");
    const state = await pollVideoGenerationTask(initial, task);
    expect(state.status).toBe("completed");
    if (state.status === "completed") expect(JSON.parse(state.result.url!.slice(5))).toMatchObject({ seconds: "4", mode: "reference", resolution: "1080p", size: null });
    expect(initial.channels[0].models[0].script).toBe(script);
});

test("existing tasks can still be queried when current Grok creation parameters are invalid", async () => {
    const initial = { ...config(), videoSeconds: "30", vquality: "1080", size: "auto" };
    const get = spyOn(axios, "get").mockResolvedValue({ data: { id: "existing", status: "in_progress" } } as never);
    try {
        expect(await pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).toEqual({ status: "pending" });
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0][0]).toBe("https://generation.example/v1/videos/existing");
    } finally { get.mockRestore(); }
});

test.each(["openai", "gemini"] as const)("video response regression: %s explicit media errors cannot become a completed URL fallback", async (provider) => {
    const initial = config("grok-imagine-video", { apiFormat: provider });
    const taskResponse = provider === "openai" ? { id: "existing", status: "completed", video_url: "https://media.example/video.mp4" } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://media.example/video.mp4" } }] } } };
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: taskResponse } as never).mockResolvedValueOnce({ data: new Blob([JSON.stringify({ code: 401, msg: "video download expired" })], { type: "application/json" }) } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider, model: initial.model })).rejects.toThrow("video download expired");
        expect(get).toHaveBeenCalledTimes(2);
    } finally { get.mockRestore(); }
});

test.each([
    ["string error code", { code: "400", msg: "video unavailable" }, "video unavailable"],
    ["string error field", { error: "video unavailable" }, "video unavailable"],
    ["numeric error code", { code: 400, msg: "video unavailable" }, "video unavailable"],
    ["object error field", { error: { message: "video unavailable" } }, "video unavailable"],
    ["nonempty unstructured error message", { error: { message: "{}" } }, "{}"],
] as const)("video response regression: a %s in downloaded content is not a video", async (_label, payload, errorMessage) => {
    const initial = config();
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status: "completed" } } as never).mockResolvedValueOnce({ data: new Blob([JSON.stringify(payload)], { type: "application/json" }) } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).rejects.toThrow(errorMessage);
        expect(get.mock.calls[1][0]).toBe("https://generation.example/v1/videos/existing/content");
    } finally { get.mockRestore(); }
});

test.each([
    ["openai", "removed::grok-imagine-video"], ["openai", "test::removed-model"],
    ["gemini", "removed::grok-imagine-video"], ["gemini", "test::removed-model"],
] as const)("video response regression: %s task recovery refuses an unavailable original model (%s)", async (provider, model) => {
    const initial = config("grok-imagine-video", { apiFormat: provider });
    const get = spyOn(axios, "get").mockResolvedValue({ data: { id: "existing", status: "in_progress" } } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider, model })).rejects.toThrow();
        expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
});

test.each(["openai", "gemini"] as const)("video response regression: %s cancellation while parsing a downloaded error remains AbortError", async (provider) => {
    const initial = config("grok-imagine-video", { apiFormat: provider });
    const controller = new AbortController();
    const blob = new Blob([], { type: "application/json" });
    const read = spyOn(blob, "text").mockImplementation(async () => { controller.abort(); return JSON.stringify({ code: 400, msg: "late download error" }); });
    const taskResponse = provider === "openai" ? { id: "existing", status: "completed" } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://media.example/video.mp4" } }] } } };
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: taskResponse } as never).mockResolvedValueOnce({ data: blob } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider, model: initial.model }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); get.mockRestore(); }
});

test.each(["openai", "gemini"] as const)("video response regression: %s still accepts video bytes and retains network URL fallback", async (provider) => {
    const initial = config("grok-imagine-video", { apiFormat: provider });
    const url = "https://media.example/video.mp4";
    const taskResponse = provider === "openai" ? { id: "existing", status: "completed", video_url: url } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: url } }] } } };
    const blob = new Blob(["video bytes"], { type: "video/mp4" });
    for (const networkFailure of [false, true]) {
        const get = spyOn(axios, "get").mockResolvedValueOnce({ data: taskResponse } as never);
        if (networkFailure) get.mockRejectedValueOnce(new axios.AxiosError("Network Error", "ERR_NETWORK"));
        else get.mockResolvedValueOnce({ data: blob } as never);
        try {
            expect(await pollVideoGenerationTask(initial, { id: "existing", provider, model: initial.model })).toEqual({ status: "completed", result: networkFailure ? { url: provider === "gemini" ? `${url}?key=test-only` : url, mimeType: "video/mp4" } : { blob } });
            expect(get).toHaveBeenCalledTimes(2);
        } finally { get.mockRestore(); }
    }
});

test.each(["openai", "gemini"] as const)("video response regression: %s download cancellation cannot fall back to a playable URL", async (provider) => {
    const initial = config("grok-imagine-video", { apiFormat: provider });
    const url = "https://media.example/video.mp4";
    const taskResponse = provider === "openai" ? { id: "existing", status: "completed", video_url: url } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: url } }] } } };
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: taskResponse } as never).mockRejectedValueOnce(new axios.CanceledError("download canceled"));
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider, model: initial.model })).rejects.toMatchObject({ name: "AbortError" });
    } finally { get.mockRestore(); }
});

test.each(["openai", "gemini"] as const)("video response regression: %s recovery keeps the original configured channel and its rotated key", async (provider) => {
    const initial = { ...config("grok-imagine-video", { apiFormat: provider }), videoSeconds: "30", vquality: "1080", size: "auto" };
    initial.channels[0].apiKey = "rotated-test-key";
    initial.channels.unshift({ ...initial.channels[0], id: "other", baseUrl: "https://wrong.example", apiKey: "wrong-test-key" });
    const task = { id: "original-task", provider, model: initial.model };
    const get = spyOn(axios, "get").mockResolvedValue({ data: provider === "gemini" ? { done: false } : { id: task.id, status: "in_progress" } } as never);
    try {
        expect(await pollVideoGenerationTask(initial, task)).toEqual({ status: "pending" });
        expect(get).toHaveBeenCalledTimes(1);
        expect(get.mock.calls[0][0]).toBe(provider === "gemini" ? "https://generation.example/v1beta/original-task" : "https://generation.example/v1/videos/original-task");
        expect(get.mock.calls[0][1]?.headers).toEqual(provider === "gemini" ? { "x-goog-api-key": "rotated-test-key", "Content-Type": "application/json" } : { Authorization: "Bearer rotated-test-key" });
        expect(task).toEqual({ id: "original-task", provider, model: initial.model });
    } finally { get.mockRestore(); }
});

test("video response regression: completed script results do not depend on a remaining channel", async () => {
    const initial = config("grok-imagine-video", { script: "return { url: 'mock:completed' };" });
    const get = spyOn(axios, "get").mockImplementation(async () => { throw new Error("Unexpected transport"); });
    try {
        const task = await createVideoGenerationTask(initial, "用户脚本");
        expect(await pollVideoGenerationTask({ ...initial, channels: [] }, task)).toEqual({ status: "completed", result: { url: "mock:completed", mimeType: "video/mp4" } });
        expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
});

test.each(["failed", "cancelled"])("strict response: %s status takes precedence over a leftover result URL", async (status) => {
    const initial = config();
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status, error: { message: "terminal failure" }, video_url: "https://media.example/old.mp4" } } as never).mockResolvedValueOnce({ data: new Blob(["video"], { type: "video/mp4" }) } as never);
    try {
        expect(await pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).toEqual({ status: "failed", error: "terminal failure" });
        expect(get).toHaveBeenCalledTimes(1);
    } finally { get.mockRestore(); }
});

test.each([
    ["empty object", {}], ["successful envelope without video bytes", { code: 0, data: {} }], ["array", []], ["null", null],
] as const)("strict response: downloaded JSON %s cannot be a successful video", async (_label, payload) => {
    const initial = config();
    const i18n = (await import("../src/i18n")).default;
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status: "completed" } } as never).mockResolvedValueOnce({ data: new Blob([JSON.stringify(payload)], { type: "application/json" }) } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).rejects.toThrow(i18n.t("apiErrors.noPlayableVideo"));
    } finally { get.mockRestore(); }
});

test("strict response: downloaded JSON message is preserved even without a numeric error code", async () => {
    const initial = config();
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status: "completed" } } as never).mockResolvedValueOnce({ data: new Blob([JSON.stringify({ message: "upstream refused media" })], { type: "application/json" }) } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).rejects.toThrow("upstream refused media");
    } finally { get.mockRestore(); }
});

test.each(["not a JSON response", '{"error":{"message":"interrupted'])('strict response: malformed JSON media cannot become a video (%s)', async (body) => {
    const initial = config();
    const i18n = (await import("../src/i18n")).default;
    const blob = new Blob([body], { type: "application/json" });
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status: "completed" } } as never).mockResolvedValueOnce({ data: blob } as never);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).rejects.toThrow(i18n.t("apiErrors.noPlayableVideo"));
    } finally { get.mockRestore(); }
});

test("strict storage: HTTP media errors cannot fall back to a successful remote URL", async () => {
    const initial = config();
    const error = new axios.AxiosError("forbidden", "ERR_BAD_REQUEST", undefined, undefined, { status: 403, data: { message: "forbidden media" } } as never);
    const get = spyOn(axios, "get").mockResolvedValueOnce({ data: { id: "existing", status: "completed", video_url: "https://media.example/result.mp4" } } as never).mockRejectedValueOnce(error);
    try {
        await expect(pollVideoGenerationTask(initial, { id: "existing", provider: "openai", model: initial.model })).rejects.toThrow("forbidden media");
    } finally { get.mockRestore(); }
});

test("strict storage: a URL result does not hide a local persistence failure", async () => {
    const { storeGeneratedVideo } = await import("../src/services/api/video");
    const storage = await import("../src/services/file-storage");
    const blob = new Blob(["video"], { type: "video/mp4" });
    const get = spyOn(axios, "get").mockResolvedValue({ data: blob } as never);
    const upload = spyOn(storage, "uploadMediaFile").mockRejectedValue(new Error("local quota failed"));
    try {
        await expect(storeGeneratedVideo({ url: "https://media.example/result.mp4" })).rejects.toThrow("local quota failed");
        expect(upload).toHaveBeenCalledWith(blob, "video");
    } finally { get.mockRestore(); upload.mockRestore(); }
});

test("strict storage: retrying a remote URL checks JSON content before saving", async () => {
    const { storeGeneratedVideo } = await import("../src/services/api/video");
    const storage = await import("../src/services/file-storage");
    const get = spyOn(axios, "get").mockResolvedValue({ data: new Blob([JSON.stringify({ error: "expired media" })], { type: "application/json" }) } as never);
    const upload = spyOn(storage, "uploadMediaFile").mockResolvedValue({ url: "blob:invalid", storageKey: "video:invalid", bytes: 1, mimeType: "application/json" });
    try {
        await expect(storeGeneratedVideo({ url: "https://media.example/result.mp4" })).rejects.toThrow("expired media");
        expect(upload).not.toHaveBeenCalled();
    } finally { get.mockRestore(); upload.mockRestore(); }
});

test("strict storage: a network-only URL fallback retains its playable URL without claiming local storage", async () => {
    const { storeGeneratedVideo } = await import("../src/services/api/video");
    const storage = await import("../src/services/file-storage");
    const get = spyOn(axios, "get").mockRejectedValue(new axios.AxiosError("CORS blocked download", "ERR_NETWORK"));
    const upload = spyOn(storage, "uploadMediaFile").mockRejectedValue(new Error("must not store"));
    try {
        expect(await storeGeneratedVideo({ url: "https://media.example/result.webm", mimeType: "video/webm" })).toEqual({ url: "https://media.example/result.webm", storageKey: "", bytes: 0, mimeType: "video/webm" });
        expect(upload).not.toHaveBeenCalled();
    } finally { get.mockRestore(); upload.mockRestore(); }
});

test("optimizer treats every Grok image as an ordinary reference without claiming frame roles or audio controls", () => {
    const initial = { ...config(), videoSeconds: "3" };
    expect(buildPromptOptimizationContext("video", initial, references(1)).durationSeconds).toBe("3");
    for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
        for (const videoMode of ["frames", "reference", "invalid"]) {
            for (const count of [0, 1, 7]) {
                const context = buildPromptOptimizationContext("video", { ...config(model), videoMode }, references(count));
                expect(context.imageRoles).toEqual(Array.from({ length: count }, () => "reference-image"));
                expect(context.referenceMode).toBe(count ? "reference" : undefined);
                expect(context.frameSize).toBe("16:9");
                expect(context.quality).toBe("720p");
                expect(context.audioEnabled).toBeUndefined();
            }
        }
    }
    expect(buildPromptOptimizationContext("video", config("grok-imagine-video-1.5"), references(2)).imageRoles).toEqual(["reference-image", "reference-image"]);
    expect(buildPromptOptimizationContext("video", initial, references(8)).imageRoles).toBeUndefined();
    const invalid = { ...initial, videoSeconds: "30", vquality: "1080", size: "auto" };
    const context = buildPromptOptimizationContext("video", invalid, references(2));
    expect(context.imageRoles || []).not.toContain("last-frame");
    expect(context.durationSeconds).toBeUndefined();
    expect(context.quality).toBeUndefined();
    expect(context.frameSize).toBeUndefined();
    expect(context.generationModel?.name).toBe("grok-imagine-video");
    expect(invalid.videoSeconds).toBe("30");
});

test("Grok optimization snapshots ignore mode, audio and watermark without changing other routes", () => {
    const read = (initial: AiConfig): PromptOptimizationInput => ({ targetId: "video-workbench", scenario: "video", prompt: "缓慢转身", references: references(1), context: buildPromptOptimizationContext("video", initial, references(1)), generationIdentity: buildPromptOptimizationGenerationIdentity("video", initial) });
    for (const initial of [config(), config("grok-imagine-video-1.5"), config("custom-video"), config("grok-imagine-video", { script: "return 'custom';" }), config("grok-imagine-video", { apiFormat: "gemini" })]) {
        const before = read(initial);
        const ignored = Boolean(getGrokVideoModel(initial));
        for (const [field, value] of [["videoMode", "reference"], ["videoMode", "invalid"], ["videoMode", ""], ["videoGenerateAudio", "false"], ["videoWatermark", "true"]] as const) {
            const after = read({ ...initial, [field]: value });
            expect(after.generationIdentity === before.generationIdentity).toBe(ignored);
            expect(samePromptOptimizationInput(before, after)).toBe(ignored);
        }
    }
});

test("changes between invalid raw video values invalidate optimization snapshots", () => {
    const read = (initial: AiConfig): PromptOptimizationInput => ({ targetId: "video-workbench", scenario: "video", prompt: "", references: [], context: buildPromptOptimizationContext("video", initial, []), generationIdentity: buildPromptOptimizationGenerationIdentity("video", initial) });
    for (const [field, before, after] of [
        ["videoSeconds", "16", "17"], ["vquality", "2048", "4096"], ["size", "auto", "invalid"],
    ]) {
        expect(samePromptOptimizationInput(read({ ...config(), [field]: before }), read({ ...config(), [field]: after }))).toBe(false);
    }
});

test("canvas Grok configuration preserves explicit empty and invalid node overrides", () => {
    const initial = { ...config(), model: defaultConfig.imageModel };
    for (const [field, metadataField] of [["size", "size"], ["videoSeconds", "seconds"], ["vquality", "vquality"]] as const) {
        for (const value of ["", "invalid"]) {
            const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: initial.videoModel, [metadataField]: value } };
            const resolved = buildGenerationConfig(initial, node, "video");
            expect(resolved.model).toBe(initial.videoModel);
            expect(resolved[field]).toBe(value);
            expect(resolveVideoGenerationConfig(resolved, { imageCount: 0 }).issues.length).toBeGreaterThan(0);
            expect(node.metadata?.[metadataField]).toBe(value);
            expect(buildGenerationConfig({ ...initial, [field]: value }, undefined, "video")[field]).toBe(value);
        }
    }
});

test("canvas Grok generation ignores legacy node modes without rewriting their metadata", () => {
    for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
        for (const videoMode of ["frames", "reference", "invalid", ""]) {
            const initial = config(model);
            const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: initial.videoModel, videoMode } };
            expect(resolveVideoGenerationConfig(buildGenerationConfig(initial, node, "video"), { imageCount: 7 })).toMatchObject({ mode: "reference", issues: [] });
            expect(node.metadata?.videoMode).toBe(videoMode);
        }
    }
});

test("canvas parameter fallback remains generic for other models and saved scripts", () => {
    for (const initial of [config("custom-video"), config("grok-imagine-video", { script: "return 'custom';" })]) {
        const node: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { model: initial.videoModel, size: "", seconds: "", vquality: "", videoMode: "" } };
        expect(buildGenerationConfig(initial, node, "video")).toMatchObject({ size: initial.size, videoSeconds: initial.videoSeconds, vquality: initial.vquality, videoMode: initial.videoMode });
    }
});
