import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import axios from "axios";
import type { AiConfig } from "../src/stores/use-config-store";
import type { AiTextMessage } from "../src/services/api/image";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { requestImageQuestion } = await import("../src/services/api/image");
const { getPluginTemplates } = await import("../src/services/api/model-plugin");
const { defaultConfig } = await import("../src/stores/use-config-store");
const scripts = { openai: getPluginTemplates().text[0].script, gemini: getPluginTemplates().text[1].script };
const config = (apiFormat: "openai" | "gemini", baseUrl = "https://provider.test"): AiConfig => {
    const model = apiFormat === "openai" ? "gpt-6.1-sol" : "gemini-3-pro";
    return {
        ...defaultConfig,
        model: "test::" + model,
        textModel: "test::" + model,
        channels: [{ id: "test", name: "Test", baseUrl, apiKey: "test-key", apiFormat, models: [{ name: model, capability: "text", script: scripts[apiFormat] }] }],
    };
};
const messages: AiTextMessage[] = [{ role: "user", content: "优化提示词" }];
const request = (settings: AiConfig, input = messages, onDelta = (_text: string) => {}) =>
    requestImageQuestion(settings, input, onDelta, { requireComplete: true });
const requestMock = spyOn(axios, "request");
afterEach(() => requestMock.mockReset());
afterAll(() => requestMock.mockRestore());

test.each([
    ["https://provider.test", "https://provider.test/v1/responses"],
    ["https://provider.test/v1/", "https://provider.test/v1/responses"],
    ["https://provider.test/proxy/v1/?tenant=test", "https://provider.test/proxy/v1/responses?tenant=test"],
])("OpenAI template maps multimodal messages using %s", async (baseUrl, expectedUrl) => {
    requestMock.mockResolvedValue({ data: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "结果" }] }] } });
    const deltas: string[] = [];
    expect(await request({ ...config("openai", baseUrl), systemPrompt: "系统指令" }, [
        { role: "assistant", content: "前文" },
        { role: "user", content: [
            { type: "text", text: "优化第一张图" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } },
            { type: "text", text: "再参考第二张" },
            { type: "image_url", image_url: { url: "https://images.test/reference.png" } },
        ] },
    ], (text) => deltas.push(text))).toBe("结果");
    expect(deltas).toEqual(["结果"]);
    const sent = requestMock.mock.calls[0][0];
    expect(sent.url).toBe(expectedUrl);
    expect(sent.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(sent.data).toEqual({ model: "gpt-6.1-sol", input: [
        { role: "system", content: "系统指令" },
        { role: "assistant", content: "前文" },
        { role: "user", content: [
            { type: "input_text", text: "优化第一张图" },
            { type: "input_image", image_url: "data:image/jpeg;base64,YQ==" },
            { type: "input_text", text: "再参考第二张" },
            { type: "input_image", image_url: "https://images.test/reference.png" },
        ] },
    ] });
});

test.each(["low", "medium", "high", "xhigh"] as const)("OpenAI template passes explicit %s reasoning", async (reasoningEffort) => {
    requestMock.mockResolvedValue({ data: { status: "completed", output_text: "结果" } });
    expect(await request({ ...config("openai"), reasoningEffort })).toBe("结果");
    expect(requestMock.mock.calls[0][0].data).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: reasoningEffort }, input: messages });
});

test.each([
    { status: "incomplete", output_text: "partial", incomplete_details: { reason: "max_output_tokens" } },
    { status: "failed", output_text: "partial" },
    { status: "cancelled", output_text: "partial" },
    { status: "completed", output_text: "partial", error: { message: "provider failure" } },
    { status: "completed", output_text: "partial", code: 429, msg: "quota failure" },
    { status: "completed", output_text: "partial", output: [{ content: [{ type: "refusal", refusal: "refused" }] }] },
    { output_text: "partial" },
    { status: "completed", output_text: "   " },
    { status: "completed", output: [{ content: [{ type: "reasoning_text", text: "hidden" }] }] },
])("OpenAI template rejects incomplete, refused, erroneous or empty output (%#)", async (data) => {
    requestMock.mockResolvedValue({ data });
    const deltas: string[] = [];
    await expect(request(config("openai"), messages, (text) => deltas.push(text))).rejects.toThrow();
    expect(deltas).toEqual([]);
});

test.each([
    ["https://provider.test", "https://provider.test/v1beta/models/gemini-3-pro:generateContent"],
    ["https://provider.test/v1beta/", "https://provider.test/v1beta/models/gemini-3-pro:generateContent"],
    ["https://provider.test/proxy/v1/?tenant=test", "https://provider.test/proxy/v1beta/models/gemini-3-pro:generateContent?tenant=test"],
])("Gemini template maps text, images and system instructions using %s", async (baseUrl, expectedUrl) => {
    requestMock.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: "内部思考", thought: true }, { text: "结果" }] }, finishReason: "STOP" }] } });
    const deltas: string[] = [];
    expect(await request({ ...config("gemini", baseUrl), systemPrompt: "系统指令" }, [
        { role: "system", content: [{ type: "text", text: "补充指令" }] },
        { role: "assistant", content: "前文" },
        { role: "user", content: [
            { type: "text", text: "优化第一张图" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,YQ==" } },
            { type: "text", text: "再参考第二张" },
            { type: "image_url", image_url: { url: "https://images.test/reference.png" } },
        ] },
    ], (text) => deltas.push(text))).toBe("结果");
    expect(deltas).toEqual(["结果"]);
    const sent = requestMock.mock.calls[0][0];
    expect(sent.url).toBe(expectedUrl);
    expect(sent.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    expect(sent.data).toEqual({
        systemInstruction: { parts: [{ text: "系统指令\n\n补充指令" }] },
        contents: [
            { role: "model", parts: [{ text: "前文" }] },
            { role: "user", parts: [
                { text: "优化第一张图" },
                { inlineData: { mimeType: "image/jpeg", data: "YQ==" } },
                { text: "再参考第二张" },
                { fileData: { fileUri: "https://images.test/reference.png", mimeType: "image/png" } },
            ] },
        ],
    });
});

test.each([
    { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] },
    { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] },
    { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
    { promptFeedback: { blockReason: "SAFETY" } },
    { error: { message: "provider failure" } },
    { candidates: [{ content: { parts: [{ text: "   " }] }, finishReason: "STOP" }] },
    { candidates: [{ content: { parts: [{ text: "内部思考", thought: true }] }, finishReason: "STOP" }] },
])("Gemini template rejects partial, blocked, erroneous or empty output (%#)", async (data) => {
    requestMock.mockResolvedValue({ data });
    const deltas: string[] = [];
    await expect(request(config("gemini"), messages, (text) => deltas.push(text))).rejects.toThrow();
    expect(deltas).toEqual([]);
});

test("loading templates preserves and executes a saved custom script", async () => {
    const settings = config("openai");
    const savedScript = 'onDelta("自定义结果"); return "自定义结果";';
    settings.channels[0].models[0].script = savedScript;
    const before = structuredClone(settings);
    getPluginTemplates();
    expect(await request(settings)).toBe("自定义结果");
    expect(settings).toEqual(before);
    expect(requestMock).not.toHaveBeenCalled();
});
