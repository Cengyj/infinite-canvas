import "./setup";
import { expect, spyOn, test } from "bun:test";

import { imageReferenceLabel } from "../src/lib/image-reference-prompt";
import { MAX_PROMPT_OPTIMIZATION_REFERENCES, requestPromptOptimization } from "../src/services/api/prompt-optimization";
import { normalizeAiConfig } from "../src/stores/use-config-store";
import type { ReferenceImage } from "../src/types/image";

function config() {
    return normalizeAiConfig({
        channels: [{
            id: "optimizer",
            name: "Optimizer",
            baseUrl: "https://provider.example/custom?tenant=mine%2Bvalue",
            apiKey: "optimizer-key",
            apiFormat: "openai",
            models: [{ name: "gpt-6-sol", capability: "text" }],
        }],
        textModel: "optimizer::gpt-6-sol",
        systemPrompt: "Existing generation instruction",
        proxyEnabled: false,
    });
}

function completed(text: string) {
    return new Response([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
    ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function reference(index: number): ReferenceImage {
    return { id: String(index), name: `Reference ${index}`, type: "image/png", dataUrl: `data:image/png;base64,${btoa(String(index))}` };
}

type CapturedBody = {
    model: string;
    store: boolean;
    stream: boolean;
    input: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: string }> }>;
};

test("prompt optimization uses the selected provider, streams with store=false, and preserves generation context", async () => {
    const initial = config();
    let requestUrl = "";
    let body!: CapturedBody;
    const deltas: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        requestUrl = String(url);
        body = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer optimizer-key");
        return completed("\u0060\u0060\u0060text\n优化后的提示词\n\u0060\u0060\u0060");
    });
    try {
        const context = { generationMode: "image-to-video" as const, referenceMode: "reference" as const, durationSeconds: "8", frameSize: "720x1280", audioEnabled: false };
        const answer = await requestPromptOptimization(initial, initial.textModel, {
            scenario: "video",
            prompt: "  原提示词  ",
            requirements: " 保留产品文字 ",
            references: [reference(1), reference(2)],
            context,
        }, (value) => deltas.push(value));
        expect(answer).toBe("优化后的提示词");
        expect(deltas).toHaveLength(1);
        expect(requestUrl).toBe("https://provider.example/custom/v1/responses?tenant=mine%2Bvalue");
        expect(body).toMatchObject({ model: "gpt-6-sol", store: false, stream: true });
        const content = body.input.find((message) => message.role === "user")!.content as Exclude<CapturedBody["input"][number]["content"], string>;
        expect(content).toHaveLength(1);
        expect(JSON.parse(content[0].text!)).toEqual({
            scenario: "video",
            sourcePrompt: "原提示词",
            additionalRequirements: "保留产品文字",
            referenceImages: [{ order: 1, label: imageReferenceLabel(0) }, { order: 2, label: imageReferenceLabel(1) }],
            generationHasReferenceImages: true,
            referenceImagesProvidedForAnalysis: false,
            generationContext: context,
        });
        expect(body.input[0].content).toContain("video");
        expect(initial.systemPrompt).toBe("Existing generation instruction");
    } finally {
        fetchMock.mockRestore();
    }
});

test("text-only optimization keeps all reference labels without fetching their images", async () => {
    let body!: CapturedBody;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return completed("Optimized");
    });
    try {
        const references = Array.from({ length: MAX_PROMPT_OPTIMIZATION_REFERENCES + 2 }, (_, index) => ({ ...reference(index), dataUrl: `https://images.example/${index}.png` }));
        const initial = config();
        await requestPromptOptimization(initial, initial.textModel, { scenario: "image", prompt: "Keep references", references }, () => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const content = body.input[1].content as Exclude<CapturedBody["input"][number]["content"], string>;
        expect(content).toHaveLength(1);
        expect(JSON.parse(content[0].text!).referenceImages).toHaveLength(references.length);
    } finally {
        fetchMock.mockRestore();
    }
});

test("reference analysis attaches images in the declared order", async () => {
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        naturalWidth = 100;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    } });
    let body!: CapturedBody;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return completed("Optimized");
    });
    try {
        const initial = config();
        const references = [reference(9), reference(3)];
        await requestPromptOptimization(initial, initial.textModel, { scenario: "image", prompt: "Preserve labels", references, analyzeReferences: true }, () => undefined);
        const content = body.input[1].content as Exclude<CapturedBody["input"][number]["content"], string>;
        expect(JSON.parse(content[0].text!).referenceImagesProvidedForAnalysis).toBe(true);
        expect(content.slice(1)).toEqual([
            { type: "input_text", text: imageReferenceLabel(0) },
            { type: "input_image", image_url: references[0].dataUrl },
            { type: "input_text", text: imageReferenceLabel(1) },
            { type: "input_image", image_url: references[1].dataUrl },
        ]);
    } finally {
        fetchMock.mockRestore();
        if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});

test("excess reference analysis fails before a network request", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network request"); });
    try {
        const initial = config();
        await expect(requestPromptOptimization(initial, initial.textModel, {
            scenario: "image",
            prompt: "Describe",
            references: Array.from({ length: MAX_PROMPT_OPTIMIZATION_REFERENCES + 1 }, (_, index) => reference(index)),
            analyzeReferences: true,
        }, () => undefined)).rejects.toThrow(String(MAX_PROMPT_OPTIMIZATION_REFERENCES));
        expect(fetchMock).not.toHaveBeenCalled();
    } finally {
        fetchMock.mockRestore();
    }
});

test("canceling during reference decoding clears the image and prevents the text request", async () => {
    const controller = new AbortController();
    const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
    let decoding!: () => void;
    const decodingStarted = new Promise<void>((resolve) => { decoding = resolve; });
    let imageSource = "";
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) { imageSource = value; if (value) decoding(); }
    } });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network request"); });
    try {
        const initial = config();
        const pending = requestPromptOptimization(initial, initial.textModel, { scenario: "image", prompt: "Describe", references: [reference(1)], analyzeReferences: true }, () => undefined, controller.signal);
        await decodingStarted;
        controller.abort();
        await expect(pending).rejects.toThrow("Aborted");
        expect(imageSource).toBe("");
        expect(fetchMock).not.toHaveBeenCalled();
    } finally {
        fetchMock.mockRestore();
        if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
        else Reflect.deleteProperty(globalThis, "Image");
    }
});

test("canceling an optimization aborts its provider request without completing a draft", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        receivedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    });
    try {
        const initial = config();
        const pending = requestPromptOptimization(initial, initial.textModel, { scenario: "image", prompt: "Describe" }, (value) => deltas.push(value), controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(receivedSignal).toBe(controller.signal);
        expect(deltas).toEqual([]);
    } finally {
        fetchMock.mockRestore();
    }
});
