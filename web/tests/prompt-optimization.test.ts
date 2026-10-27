import { expect, spyOn, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";
import type { PromptOptimizationInput } from "../src/lib/prompt-optimization";

// Only provide storage while browser modules initialize; do not replace their exports.
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/lib/prompt-optimization"), import("../src/services/api/prompt-optimization"), import("../src/stores/use-config-store"), import("../src/i18n")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ buildPromptOptimizationContext, samePromptOptimizationInput, promptOptimizationTokens }, { requestPromptOptimization }, { defaultConfig }, { default: i18n }] = dependencies;

function config(script?: string): AiConfig {
    return {
        ...defaultConfig,
        textModel: "optimizer::text-model",
        channels: [{ id: "optimizer", name: "Optimizer", baseUrl: "https://optimizer.example", apiKey: "test-only", apiFormat: "openai", models: [{ name: "text-model", capability: "text", script }] }],
    };
}

function input(): PromptOptimizationInput & { requirements: string; analyzeReferences: boolean } {
    return { targetId: "project:node", scenario: "image", prompt: "产品海报", references: [], context: { frameSize: "1024x1536", transparentBackground: true }, requirements: "保留产品名称", analyzeReferences: false };
}

const captureUserInput = 'return JSON.stringify({ model, baseUrl, apiKey, messages: messages.filter(message => message.role === "user"), separatesContext: systemPrompt.includes("do not copy it") });';

test("optimization uses the selected text channel and separates read-only upstream context", async () => {
    const original = config(captureUserInput);
    const request = { ...input(), context: { ...input().context, upstreamText: "包装上的文字必须是晴山", videoReferences: ["视频1：产品旋转"], audioReferences: ["音频1：背景音乐"] } };
    const result = JSON.parse(await requestPromptOptimization(original, original.textModel, request, () => {}));
    expect(result).toMatchObject({ model: "text-model", baseUrl: "https://optimizer.example", apiKey: "test-only", separatesContext: true });
    const data = JSON.parse(result.messages[0].content[0].text);
    expect(data).toMatchObject({ sourcePrompt: "产品海报", additionalRequirements: "保留产品名称", upstreamText: request.context.upstreamText, videoReferences: request.context.videoReferences, audioReferences: request.context.audioReferences });
    expect(data.generationContext).toEqual({ frameSize: "1024x1536", transparentBackground: true });
    expect(original.systemPrompt).toBe(defaultConfig.systemPrompt);
});

test("generation instructions are sent as read-only context rather than replacing the optimization contract", async () => {
    const initial = config(captureUserInput);
    const context = buildPromptOptimizationContext("image", { ...initial, systemPrompt: "保留包装正面文字" }, []);
    const result = JSON.parse(await requestPromptOptimization(initial, initial.textModel, { ...input(), context }, () => {}));
    const data = JSON.parse(result.messages[0].content[0].text);
    expect(data.generationContext.generationSystemPrompt).toBe("保留包装正面文字");
    expect(data.sourcePrompt).toBe(input().prompt);
    expect(result.separatesContext).toBe(true);
    expect(initial.systemPrompt).toBe(defaultConfig.systemPrompt);
});

test("reference analysis is opt-in, keeps order and has no inherited four-image limit", async () => {
    const initial = config(captureUserInput);
    const references = Array.from({ length: 6 }, (_, index) => ({ id: String(index), name: `reference-${index}`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(String(index))}` }));
    const analyze = async (enabled: boolean) => {
        const result = JSON.parse(await requestPromptOptimization(initial, initial.textModel, { ...input(), references, analyzeReferences: enabled }, () => {}));
        return result.messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    expect(await analyze(false)).toHaveLength(1);
    const content = await analyze(true);
    expect(JSON.parse(content[0].text!).referenceImagesProvidedForAnalysis).toBe(true);
    expect(content.filter((part) => part.type === "image_url").map((part) => part.image_url?.url)).toEqual(references.map((reference) => reference.dataUrl));
});

test("video image roles are explicit with and without analysis and local generation identity is not sent", async () => {
    const initial = config(captureUserInput);
    const references = ["ending.png", "opening.png"].map((name, index) => ({ id: String(index), name, type: "image/png", dataUrl: `data:image/png;base64,${btoa(String(index))}` }));
    for (const analyzeReferences of [false, true]) {
        const result = JSON.parse(await requestPromptOptimization(initial, initial.textModel, {
            ...input(), scenario: "video", prompt: "从闭合的花苞缓慢绽放", references, analyzeReferences,
            generationIdentity: "local-only-script-identity",
            context: { referenceMode: "frames", imageRoles: ["first-frame", "last-frame"], durationSeconds: "4" },
        }, () => {}));
        const content = result.messages[0].content;
        const data = JSON.parse(content[0].text);
        expect(data.referenceImages).toEqual([
            { label: "图片1", name: "ending.png", role: "first-frame" },
            { label: "图片2", name: "opening.png", role: "last-frame" },
        ]);
        expect(JSON.stringify(content)).not.toContain("local-only-script-identity");
        expect(data.referenceImagesProvidedForAnalysis).toBe(analyzeReferences);
        if (analyzeReferences) {
            expect(content[1].text).toContain("first-frame");
            expect(content[3].text).toContain("last-frame");
        }
    }
});

test("visible quotation marks, Chinese packaging text and body line breaks remain untouched", async () => {
    const body = '包装正面仅写：\n“晴山”\n净含量：250g\n保持「低糖，不减风味！」的标点和换行。';
    const initial = config(`return ${JSON.stringify(body)};`);
    expect(await requestPromptOptimization(initial, initial.textModel, { ...input(), prompt: body }, () => {})).toBe(body);
});

test("missing models, removed channels, and wrong capabilities never fall back", async () => {
    const initial = config('throw new Error("unexpected provider request");');
    for (const model of ["removed::text-model", "optimizer::deleted", ""]) {
        await expect(requestPromptOptimization(initial, model, input(), () => {})).rejects.toThrow(i18n.t("promptOptimization.errors.modelUnavailable"));
    }
    const wrongCapability: AiConfig = { ...initial, channels: [{ ...initial.channels[0], models: [{ name: "text-model", capability: "image" }] }] };
    await expect(requestPromptOptimization(wrongCapability, initial.textModel, input(), () => {})).rejects.toThrow(i18n.t("promptOptimization.errors.modelUnavailable"));
    await expect(requestPromptOptimization({ ...initial, channels: [{ ...initial.channels[0], apiKey: "" }] }, initial.textModel, input(), () => {})).rejects.toThrow(i18n.t("apiErrors.apiKeyRequired"));
});

test("tokens preserve first appearance order and cannot be added, removed, or replaced with labels", async () => {
    const request = { ...input(), prompt: "用 @[node:image-1] 表现 @[node:text-1]", context: { referenceTokens: [{ token: "@[node:image-1]", label: "图片1" }, { token: "@[node:text-1]", label: "文本1" }] } };
    const valid = "保持 @[node:image-1] 的外观，根据 @[node:text-1] 优化 @[node:image-1]";
    const initial = config(`return ${JSON.stringify(valid)};`);
    expect(await requestPromptOptimization(initial, initial.textModel, request, () => {})).toBe(valid);
    for (const answer of ["使用图片1表现文本1", "用 @[node:image-1] 表现文字", `${valid} @[node:extra]`, "根据 @[node:text-1] 优化 @[node:image-1]"]) {
        const invalid = config(`return ${JSON.stringify(answer)};`);
        await expect(requestPromptOptimization(invalid, invalid.textModel, request, () => {})).rejects.toThrow(i18n.t("promptOptimization.errors.tokensChanged"));
    }
    expect(promptOptimizationTokens(valid)).toEqual(["@[node:image-1]", "@[node:text-1]"]);
    expect(promptOptimizationTokens("@[node:z] @[node:a] @[node:z]")).toEqual(["@[node:z]", "@[node:a]"]);
});

test("cancellation rejects a pre-canceled request and ignores late scripted previews", async () => {
    const preCanceled = new AbortController();
    const reason = new Error("stopped");
    preCanceled.abort(reason);
    const initial = config('throw new Error("unexpected provider request");');
    await expect(requestPromptOptimization(initial, initial.textModel, input(), () => {}, preCanceled.signal)).rejects.toBe(reason);

    const controller = new AbortController();
    const scripted = config('await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); onDelta("preview"); }); onDelta("late"); return "late";');
    const deltas: string[] = [];
    await expect(requestPromptOptimization(scripted, scripted.textModel, input(), (text) => { deltas.push(text); controller.abort(); }, controller.signal)).rejects.toBeInstanceOf(Error);
    expect(deltas).toEqual(["preview"]);
});

test("strict optimization never accepts a truncated stream and requests store=false", async () => {
    const initial = config();
    let payload: Record<string, unknown> = {};
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
        payload = JSON.parse(String(options?.body));
        return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    try {
        await expect(requestPromptOptimization(initial, initial.textModel, input(), () => {})).rejects.toBeInstanceOf(Error);
        expect(payload).toMatchObject({ stream: true, store: false, model: "text-model" });
    } finally {
        fetchMock.mockRestore();
    }
});

test("snapshots invalidate changed targets, drafts, media content, order, or upstream text", () => {
    const original = { ...input(), references: [{ id: "a", name: "A", type: "image/png", storageKey: "image:a", dataUrl: "blob:a" }, { id: "b", name: "B", type: "image/png", dataUrl: "blob:b" }] };
    const same = { ...original, references: original.references.map((reference) => ({ ...reference })), context: { transparentBackground: true, frameSize: "1024x1536" } };
    expect(samePromptOptimizationInput(original, same)).toBe(true);
    for (const changed of [
        { ...same, targetId: "other-project:node" },
        { ...same, prompt: "手动修改" },
        { ...same, references: [...same.references].reverse() },
        { ...same, references: [{ ...same.references[0], name: "新的参考图名称" }, same.references[1]] },
        { ...same, references: [{ ...same.references[0], dataUrl: "blob:new-content" }, same.references[1]] },
        { ...same, references: [{ ...same.references[0], storageKey: "image:new" }, same.references[1]] },
        { ...same, context: { ...same.context, upstreamText: "新增文字" } },
    ]) expect(samePromptOptimizationInput(original, changed)).toBe(false);
});

test("context keeps image quality independent and uses current video bounds and reference mode", () => {
    const initial = { ...config(), size: "1024x1536", quality: "max", videoSeconds: "2", vquality: "720", videoGenerateAudio: "false" };
    expect(buildPromptOptimizationContext("image", initial, [])).toMatchObject({ frameSize: "1024x1536", quality: "max" });
    expect(buildPromptOptimizationContext("video", { ...initial, size: "9:16" }, [])).toMatchObject({ frameSize: "720x1280", durationSeconds: "4", referenceMode: "frames", audioEnabled: false });
    const references = Array.from({ length: 3 }, (_, index) => ({ id: String(index), name: "", type: "image/png", dataUrl: "" }));
    expect(buildPromptOptimizationContext("video", initial, references).referenceMode).toBe("reference");
});
