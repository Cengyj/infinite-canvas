import { expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import axios from "axios";
import type { AiConfig, ApiCallFormat } from "../src/stores/use-config-store";
import type { PromptOptimizationInput } from "../src/lib/prompt-optimization";
import type { ReferenceImage } from "../src/types/image";
import type { CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/lib/prompt-optimization"), import("../src/stores/use-config-store"), import("../src/services/api/video"), import("../src/lib/canvas/canvas-prompt-optimization"), import("../src/types/canvas"), import("../src/services/api/image")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ buildPromptOptimizationContext, buildPromptOptimizationGenerationIdentity, samePromptOptimizationInput }, { defaultConfig }, { createVideoGenerationTask }, { buildCanvasPromptOptimizationInput }, { CanvasNodeType }, { requestGeneration }] = dependencies;
const references: ReferenceImage[] = Array.from({ length: 3 }, (_, index) => ({ id: String(index), name: `图片${index + 1}`, type: "image/png", dataUrl: "data:image/png;base64,AA==" }));
const media = { videoReferences: ["视频1", "视频2"], audioReferences: ["音频1", "音频2"] };

function config(apiFormat: ApiCallFormat = "openai", script?: string): AiConfig {
    return { ...defaultConfig, model: "test::generator", videoModel: "test::generator", size: "9:16", channels: [{ id: "test", name: "test", apiFormat, apiKey: "test-only", baseUrl: "https://generation.example", models: [{ name: "generator", capability: "video", script }] }] };
}

test("image intent distinguishes creation, references and a known source image", () => {
    expect(buildPromptOptimizationContext("image", config(), [])).toMatchObject({ imageIntent: "create", imageRoles: [] });
    expect(buildPromptOptimizationContext("image", config(), references)).toMatchObject({ imageIntent: "reference", imageRoles: references.map(() => "reference-image") });
    expect(buildPromptOptimizationContext("image", config(), references, { sourceImageId: "1" })).toMatchObject({ imageIntent: "edit", imageRoles: ["reference-image", "source-image", "reference-image"] });
    expect(buildPromptOptimizationContext("image", config(), references, { sourceImageId: "removed" }).imageIntent).toBe("reference");
});

test("image generation instructions invalidate optimization snapshots without altering the draft", () => {
    const initial = { ...config(), systemPrompt: "保留品牌标识和包装文字" };
    const read = (value: AiConfig): PromptOptimizationInput => ({ targetId: "image-workbench", scenario: "image", prompt: "商品海报", references: [], context: buildPromptOptimizationContext("image", value, []) });
    const original = read(initial);
    expect(original.context.generationSystemPrompt).toBe(initial.systemPrompt);
    expect(original.prompt).toBe("商品海报");
    expect(samePromptOptimizationInput(original, read({ ...initial, systemPrompt: "保持透明背景" }))).toBe(false);
    expect(buildPromptOptimizationContext("video", initial, []).generationSystemPrompt).toBeUndefined();
});

test.each([
    ["864x2016", "9:16", "1K"],
    ["1000x2000", "9:16", "2K"],
    ["9:21", "9:16", undefined],
    ["auto", undefined, undefined],
] as const)("Gemini image context agrees with the actual request for %s", async (size, aspectRatio, imageSize) => {
    const initial: AiConfig = { ...config("gemini"), size, imageModel: "test::generator", count: "1", channels: [{ ...config("gemini").channels[0], models: [{ name: "generator", capability: "image" }] }] };
    let submitted: { generationConfig?: { imageConfig?: { aspectRatio?: string; imageSize?: string } } } | undefined;
    const post = spyOn(axios, "post").mockImplementation(async (_url, data) => {
        submitted = data;
        return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "dGVzdA==" } }] } }] } } as never;
    });
    try {
        const context = buildPromptOptimizationContext("image", initial, []);
        await requestGeneration(initial, "商品海报");
        expect(context.frameSize).toBe(aspectRatio);
        expect(context.resolution).toBe(imageSize);
        expect(context.frameSize).toBe(submitted?.generationConfig?.imageConfig?.aspectRatio);
        expect(context.resolution).toBe(submitted?.generationConfig?.imageConfig?.imageSize);
        expect(initial.size).toBe(size);
    } finally {
        post.mockRestore();
    }
});

test("native Gemini image context excludes quality that generation does not submit", async () => {
    const initial: AiConfig = { ...config("gemini"), size: "1024x1024", quality: "max", background: "transparent", count: "1", channels: [{ ...config("gemini").channels[0], models: [{ name: "generator", capability: "image" }] }] };
    let submitted: { generationConfig?: Record<string, unknown> } | undefined;
    const post = spyOn(axios, "post").mockImplementation(async (_url, data) => {
        submitted = data;
        return { data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "dGVzdA==" } }] } }] } } as never;
    });
    try {
        const context = buildPromptOptimizationContext("image", initial, []);
        await requestGeneration(initial, "商品海报");
        expect(submitted?.generationConfig).toMatchObject({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: context.frameSize, imageSize: context.resolution } });
        expect(submitted?.generationConfig).not.toHaveProperty("quality");
        expect(context.quality).toBeUndefined();
        expect(JSON.parse(JSON.stringify(context))).not.toHaveProperty("quality");
        expect(context.transparentBackground).toBe(true);
    } finally {
        post.mockRestore();
    }
});

test("image snapshots ignore only native Gemini quality while tracking effective image config", () => {
    const read = (value: AiConfig): PromptOptimizationInput => ({ targetId: "image-workbench", scenario: "image", prompt: "商品海报", references: [], context: buildPromptOptimizationContext("image", value, []), generationIdentity: buildPromptOptimizationGenerationIdentity("image", value) });
    const initial = { ...config("gemini"), quality: "low", size: "1024x1024" };
    const original = read(initial);
    expect(samePromptOptimizationInput(original, read({ ...initial, quality: "max" }))).toBe(true);
    for (const size of ["1024x1536", "2048x2048"]) {
        const changed = read({ ...initial, size });
        expect(changed.context).not.toEqual(original.context);
        expect(samePromptOptimizationInput(original, changed)).toBe(false);
    }
    for (const transport of [config(), config("openai", "return params;"), config("gemini", "return params;")]) {
        const low = read({ ...transport, quality: "low" });
        const high = read({ ...transport, quality: "max" });
        expect(low.context.quality).toBe("low");
        expect(high.context.quality).toBe("max");
        expect(samePromptOptimizationInput(low, high)).toBe(false);
    }
});

test("unfinished Gemini sizes do not crash optimization snapshot reads", () => {
    for (const size of ["invalid", "0x2000", "9:"]) {
        const context = buildPromptOptimizationContext("image", { ...config("gemini"), size }, []);
        expect(context.frameSize).toBeUndefined();
        expect(context.resolution).toBeUndefined();
    }
});

test("image size edits invalidate local snapshots even when effective Gemini settings coincide", () => {
    const read = (size: string): PromptOptimizationInput => {
        const initial = { ...config("gemini"), size };
        return { targetId: "image-workbench", scenario: "image", prompt: "商品海报", references: [], context: buildPromptOptimizationContext("image", initial, []), generationIdentity: buildPromptOptimizationGenerationIdentity("image", initial) };
    };
    for (const [before, after] of [["auto", "invalid"], ["invalid", "9:"], ["1024x1024", "1000x1000"]]) {
        expect(read(before).context).toEqual(read(after).context);
        expect(samePromptOptimizationInput(read(before), read(after))).toBe(false);
    }
});

test("video image roles follow the exact frames/reference contract for every transport", () => {
    for (const initial of [config(), config("gemini"), config("openai", "return params.mode;")]) {
        expect(buildPromptOptimizationContext("video", initial, []).imageRoles).toEqual([]);
        expect(buildPromptOptimizationContext("video", initial, references.slice(0, 1)).imageRoles).toEqual(["first-frame"]);
        expect(buildPromptOptimizationContext("video", initial, references.slice(0, 2)).imageRoles).toEqual(["first-frame", "last-frame"]);
        expect(buildPromptOptimizationContext("video", initial, references)).toMatchObject({ referenceMode: "reference", imageRoles: references.map(() => "reference-image") });
        expect(buildPromptOptimizationContext("video", { ...initial, videoMode: "reference" }, references.slice(0, 1))).toMatchObject({ referenceMode: "reference", imageRoles: ["reference-image"] });
    }
});

test("media context contains only inputs the selected transport uses and does not change frames mode", () => {
    for (const initial of [config(), config("gemini", "return params.mode;")]) {
        expect(buildPromptOptimizationContext("video", initial, [], media)).toMatchObject({ referenceMode: "frames", imageRoles: [], ...media });
    }
    expect(buildPromptOptimizationContext("video", config("gemini"), [], media)).toMatchObject({ referenceMode: "frames", videoReferences: ["视频1"], audioReferences: ["音频1"] });
});

test("context reflects transport defaults and preserves existing duration normalization", () => {
    expect(buildPromptOptimizationContext("video", { ...config(), size: "auto", videoSeconds: "-1" }, [])).toMatchObject({ frameSize: "1280x720", quality: "720p", durationSeconds: "4" });
    expect(buildPromptOptimizationContext("video", { ...config("gemini"), size: "auto", vquality: "low" }, [])).toMatchObject({ frameSize: "16:9", quality: "480p" });
    expect(buildPromptOptimizationContext("video", { ...config("gemini", "return params;"), size: "auto" }, [])).toMatchObject({ frameSize: "auto", generationModel: { id: "test::generator", name: "generator", transport: "script" } });
    expect(buildPromptOptimizationContext("video", { ...config(), size: "1024x1536" }, []).frameSize).toBe("1024x1536");
});

test("snapshots invalidate generation model, protocol, endpoint, script and semantic role changes", () => {
    const initial = config();
    const read = (value: AiConfig): PromptOptimizationInput => ({ targetId: "workbench", scenario: "video", prompt: "产品旋转", references, context: buildPromptOptimizationContext("video", value, references), generationIdentity: buildPromptOptimizationGenerationIdentity("video", value) });
    const original = read(initial);
    for (const changed of [
        { ...initial, model: "test::other" },
        config("gemini"),
        config("openai", "return 'new script';"),
        { ...initial, channels: [{ ...initial.channels[0], baseUrl: "https://other.example" }] },
    ]) expect(samePromptOptimizationInput(original, read(changed))).toBe(false);
    expect(samePromptOptimizationInput(read(config("openai", "return 1;")), read(config("openai", "return 2;")))).toBe(false);
    expect(samePromptOptimizationInput(original, { ...original, context: { ...original.context, imageIntent: "edit" } })).toBe(false);
    expect(samePromptOptimizationInput(original, { ...original, context: { ...original.context, imageRoles: ["first-frame", "last-frame", "reference-image"] } })).toBe(false);
    expect(samePromptOptimizationInput(original, read({ ...initial, channels: [{ ...initial.channels[0], apiKey: "other-test-only" }] }))).toBe(true);
});

test("canvas source-image roles and generation model match new-node and overwrite behavior", () => {
    const node = { id: "image", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "blob:image", model: defaultConfig.imageModel } };
    const read = (nodeRegenerateBehavior: "new-node" | "overwrite") => buildCanvasPromptOptimizationInput("project", node.id, "image", "把背景改成蓝色", [node], [], { ...defaultConfig, nodeRegenerateBehavior })!;
    expect(read("new-node").context).toMatchObject({ imageIntent: "edit", imageRoles: ["source-image"], generationModel: { id: defaultConfig.imageModel } });
    expect(read("overwrite").context).toMatchObject({ imageIntent: "create", imageRoles: [] });
    expect(read("overwrite").references).toHaveLength(0);
});

test("image config tokens keep media descriptions without claiming media generation inputs", () => {
    const prompt = "参考 @[node:video] 和 @[node:audio] 的名字设计海报";
    const nodes: CanvasNodeData[] = [
        { id: "config", type: CanvasNodeType.Config, title: "配置", metadata: { composerContent: prompt } },
        { id: "video", type: CanvasNodeType.Video, title: "雨夜散步", metadata: { content: "blob:video" } },
        { id: "audio", type: CanvasNodeType.Audio, title: "爵士乐", metadata: { content: "blob:audio" } },
    ].map((node) => ({ ...node, position: { x: 0, y: 0 }, width: 100, height: 100 }));
    const connections = ["video", "audio"].map((id) => ({ id, fromNodeId: id, toNodeId: "config" }));
    const input = buildCanvasPromptOptimizationInput("project", "config", "image", prompt, nodes, connections, defaultConfig)!;
    expect(input.context.videoReferences).toBeUndefined();
    expect(input.context.audioReferences).toBeUndefined();
    expect(input.context.referenceTokens?.map((token) => token.description)).toEqual(["雨夜散步", "爵士乐"]);
    expect(input.prompt).toBe(prompt);
});

test("built-in video requests agree with optimization roles and effective media references", async () => {
    const originalReader = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
    if (!originalReader) Object.defineProperty(globalThis, "FileReader", { configurable: true, value: class {
        result = "";
        onload?: () => void;
        readAsDataURL(blob: Blob) {
            void blob.arrayBuffer().then((buffer) => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`; this.onload?.(); });
        }
    } });
    const videos = media.videoReferences.map((name, index) => ({ id: `video-${index}`, name, url: `data:video/mp4;base64,${btoa(String(index))}` }));
    const audios = media.audioReferences.map((name, index) => ({ id: `audio-${index}`, name, url: `data:audio/mpeg;base64,${btoa(String(index))}` }));
    let body: FormData | Record<string, any>;
    const post = spyOn(axios, "post").mockImplementation(async (_url, data) => {
        body = data;
        return { data: { id: "test-task", name: "operations/test-task" } } as never;
    });
    try {
        for (const format of ["openai", "gemini"] as const) {
            for (const refs of [references.slice(0, 2), references]) {
                const initial = { ...config(format), size: "auto", videoSeconds: "-1" };
                const context = buildPromptOptimizationContext("video", initial, refs, media);
                await createVideoGenerationTask(initial, "产品旋转", refs, { videos, audios });
                if (body! instanceof FormData) {
                    expect(body.get("size")).toBe(context.frameSize!);
                    expect(body.get("seconds")).toBe(context.durationSeconds!);
                    expect(body.get("mode")).toBe(context.referenceMode!);
                    expect(body.getAll("video[]")).toHaveLength(context.videoReferences!.length);
                    expect(body.getAll("audio[]")).toHaveLength(context.audioReferences!.length);
                    expect(body.has("first_frame")).toBe(context.imageRoles!.includes("first-frame"));
                    expect(body.has("last_frame")).toBe(context.imageRoles!.includes("last-frame"));
                    expect(body.getAll("image[]")).toHaveLength(context.imageRoles!.filter((role) => role === "reference-image").length);
                } else {
                    const request = body! as Record<string, any>;
                    const instance = request.instances[0];
                    expect(request.parameters.aspectRatio).toBe(context.frameSize!);
                    expect(String(request.parameters.durationSeconds)).toBe(context.durationSeconds!);
                    expect(Boolean(instance.image)).toBe(context.imageRoles!.includes("first-frame"));
                    expect(Boolean(instance.lastFrame)).toBe(context.imageRoles!.includes("last-frame"));
                    expect(instance.referenceImages || []).toHaveLength(context.imageRoles!.filter((role) => role === "reference-image").length);
                    expect(context.videoReferences).toEqual([videos[0].name]);
                    expect(context.audioReferences).toEqual([audios[0].name]);
                    expect(instance.video.bytesBase64Encoded).toBe(btoa("0"));
                    expect(instance.audio.bytesBase64Encoded).toBe(btoa("0"));
                }
            }
        }
    } finally {
        post.mockRestore();
        if (!originalReader) Reflect.deleteProperty(globalThis, "FileReader");
    }
});
