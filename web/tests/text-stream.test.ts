import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";

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
const { defaultConfig } = await import("../src/stores/use-config-store");
const messages = [{ role: "user" as const, content: "优化这个提示词" }];
const config = (apiFormat: "openai" | "gemini", script?: string, model = "text-model"): AiConfig => ({
    ...defaultConfig,
    model: "test::" + model,
    textModel: "test::" + model,
    channels: [{ id: "test", name: "Test", baseUrl: "https://provider.test", apiKey: "test-key", apiFormat, models: [{ name: model, capability: "text", script }] }],
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (text: string) => event({ type: "response.completed", response: { status: "completed", output_text: text } });
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const fetchMock = spyOn(globalThis, "fetch");
afterEach(() => fetchMock.mockReset());
afterAll(() => fetchMock.mockRestore());
const request = (provider: "openai" | "gemini", onDelta = (_text: string) => {}, signal?: AbortSignal) =>
    requestImageQuestion(config(provider), messages, onDelta, { requireComplete: true, store: false, signal });

test("strict Responses handles split UTF-8, uses final text and stops a completed stream", async () => {
    const bytes = new TextEncoder().encode(event({ type: "response.output_text.delta", delta: "草稿" }) + completed("完整结果"));
    let canceled = false;
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
        start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); },
        cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    const deltas: string[] = [];
    expect(await request("openai", (text) => deltas.push(text))).toBe("完整结果");
    expect(deltas).toEqual(["草稿", "完整结果"]);
    expect(canceled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://provider.test/v1/responses");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "text-model", stream: true, store: false });
});

test("strict Gemini accumulates text and requires STOP", async () => {
    fetchMock.mockResolvedValue(sse(event({ candidates: [{ content: { parts: [{ text: "第一段" }] } }] })
        + event({ candidates: [{ content: { parts: [{ text: "第二段" }] }, finishReason: "STOP" }] })));
    const deltas: string[] = [];
    expect(await request("gemini", (text) => deltas.push(text))).toBe("第一段第二段");
    expect(deltas).toEqual(["第一段", "第一段第二段"]);
});

test.each(["auto", "low", "medium", "high", "xhigh"] as const)("native gpt-6.1-sol maps multimodal messages and reasoning %s", async (reasoningEffort) => {
    fetchMock.mockResolvedValue(sse(completed("完整结果")));
    await requestImageQuestion({ ...config("openai", undefined, "gpt-6.1-sol"), systemPrompt: "系统指令", reasoningEffort }, [{
        role: "user",
        content: [
            { type: "text", text: "先看参考图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
            { type: "text", text: "再优化提示词" },
        ],
    }], () => {}, { requireComplete: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.input).toEqual([
        { role: "system", content: "系统指令" },
        { role: "user", content: [
            { type: "input_text", text: "先看参考图" },
            { type: "input_image", image_url: "data:image/png;base64,YQ==" },
            { type: "input_text", text: "再优化提示词" },
        ] },
    ]);
    if (reasoningEffort === "auto") expect(body).not.toHaveProperty("reasoning");
    else expect(body.reasoning).toEqual({ effort: reasoningEffort });
});

test.each(["stream", "json"] as const)("native Gemini omits thought text from %s answers", async (format) => {
    const payload = { candidates: [{ content: { parts: [{ text: "内部思考", thought: true }, { text: "公开回答" }] }, finishReason: "STOP" }] };
    fetchMock.mockResolvedValue(format === "stream" ? sse(event(payload)) : Response.json(payload));
    const deltas: string[] = [];
    expect(await request("gemini", (text) => deltas.push(text))).toBe("公开回答");
    expect(deltas.join("")).not.toContain("内部思考");
    if (format === "stream") expect(deltas).toEqual(["公开回答"]);
});

test.each(["stream", "json"] as const)("native Gemini rejects thought-only %s answers", async (format) => {
    const payload = { candidates: [{ content: { parts: [{ text: "内部思考", thought: true }] }, finishReason: "STOP" }] };
    fetchMock.mockResolvedValue(format === "stream" ? sse(event(payload)) : Response.json(payload));
    const deltas: string[] = [];
    await expect(request("gemini", (text) => deltas.push(text))).rejects.toThrow();
    expect(deltas).toEqual([]);
});

test.each([
    ["openai", event({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n"],
    ["openai", event({ type: "response.incomplete", response: { status: "incomplete", output_text: "partial", incomplete_details: { reason: "max_output_tokens" } } })],
    ["openai", event({ type: "response.failed", response: { status: "failed", error: { message: "upstream failed" } } })],
    ["openai", event({ type: "response.cancelled", response: { status: "cancelled", output_text: "partial" } })],
    ["openai", event({ type: "response.refusal.delta", delta: "refused" }) + completed("partial")],
    ["openai", event({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "refused" }] }] } })],
    ["openai", event({ type: "error", message: "provider error" }) + completed("partial")],
    ["openai", "data: {broken}\n\n"],
    ["openai", completed("")],
    ["gemini", event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })],
    ["gemini", event({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] })],
    ["gemini", event({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" }] })],
    ["gemini", event({ promptFeedback: { blockReason: "SAFETY" } })],
    ["gemini", event({ error: { message: "quota failed" } })],
    ["gemini", event({ candidates: [{ finishReason: "STOP" }] })],
] as const)("strict %s rejects partial, refused, malformed or empty output (%#)", async (provider, body) => {
    fetchMock.mockResolvedValue(sse(body));
    await expect(request(provider)).rejects.toBeInstanceOf(Error);
});

test("strict JSON fallback validates completion and surfaces errors", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ status: "completed", output_text: "done" }));
    expect(await request("openai")).toBe("done");
    fetchMock.mockResolvedValueOnce(Response.json({ output_text: "partial" }));
    await expect(request("openai")).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "provider detail" } }));
    await expect(request("openai")).rejects.toThrow("provider detail");
    fetchMock.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
    expect(await request("gemini")).toBe("done");
    fetchMock.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }));
    await expect(request("gemini")).rejects.toThrow();
});

test.each(["openai", "gemini"] as const)("strict %s surfaces HTTP errors and read failures", async (provider) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "quota detail" } }, { status: 429 }));
    await expect(request(provider)).rejects.toThrow("quota detail");
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }), { headers: { "content-type": "text/event-stream" } }));
    await expect(request(provider)).rejects.toThrow("connection lost");
});

test("strict cancellation before a request prevents provider calls", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request("openai", undefined, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetchMock).not.toHaveBeenCalled();
});

test("strict cancellation during a stream rejects the draft and releases its reader", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Canceled", "AbortError");
    const body = new ReadableStream<Uint8Array>({
        start(stream) {
            stream.enqueue(new TextEncoder().encode(event({ type: "response.output_text.delta", delta: "draft" })));
            controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
        },
    });
    fetchMock.mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(request("openai", () => controller.abort(reason), controller.signal)).rejects.toBe(reason);
    expect(body.locked).toBe(false);
});

test.each(["return undefined;", "return {};", 'return "   ";', 'onDelta({ text: "invalid" }); return "done";'])("strict text scripts reject invalid output (%#)", async (script) => {
    await expect(requestImageQuestion(config("openai", script), messages, () => {}, { requireComplete: true })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
});

test("strict scripts receive reference images and return their own text", async () => {
    const script = 'onDelta("draft"); return images[0] + ":" + messages.length;';
    const deltas: string[] = [];
    const result = await requestImageQuestion(config("openai", script), [{ role: "user", content: [{ type: "text", text: "optimize" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }], (text) => deltas.push(text), { requireComplete: true });
    expect(result).toBe("data:image/png;base64,YQ==:1");
    expect(deltas).toEqual(["draft"]);
});

test("a script returning after cancellation cannot complete an optimization", async () => {
    const controller = new AbortController();
    const script = 'await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); return "late result";';
    const result = requestImageQuestion(config("openai", script), messages, () => {}, { requireComplete: true, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toBe(controller.signal.reason);
});

test("default text requests keep accepting partial streams and existing script values", async () => {
    fetchMock.mockResolvedValue(sse(event({ type: "response.output_text.delta", delta: "legacy partial" })));
    expect(await requestImageQuestion(config("openai"), messages, () => {})).toBe("legacy partial");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("store");
    expect(await requestImageQuestion(config("openai", "return 42;"), messages, () => {})).toBe("42");
});
