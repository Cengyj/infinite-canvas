import "./setup";
import { expect, spyOn, test } from "bun:test";
import { requestImageQuestion } from "../src/services/api/image";
import { normalizeAiConfig } from "../src/stores/use-config-store";

const messages = [{ role: "user" as const, content: "hello" }];
const configs = Object.fromEntries(["openai", "gemini"].map((apiFormat) => [apiFormat, normalizeAiConfig({
    channels: [{ id: "test", name: "Test", baseUrl: "https://provider.test/root?tenant=mine", apiKey: "test-only", apiFormat: apiFormat as "openai" | "gemini", models: [{ name: "text-test", capability: "text" }] }],
    model: "test::text-test", textModel: "test::text-test",
})]));
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

test("Responses accepts split UTF-8 chunks only after a completed event and cancels the reader", async () => {
    const body = new TextEncoder().encode(event({ type: "response.output_text.delta", delta: "你好" }) + event({ type: "response.completed", response: { status: "completed", output_text: "你好" } }));
    let canceled = false;
    const mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
        start(controller) { for (const byte of body) controller.enqueue(new Uint8Array([byte])); },
        cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
        const deltas: string[] = [];
        expect(await requestImageQuestion(configs.openai, messages, (text) => deltas.push(text))).toBe("你好");
        expect(deltas.at(-1)).toBe("你好");
        expect(canceled).toBe(true);
    } finally { mock.mockRestore(); }
});

test.each([
    ["openai", event({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n"],
    ["openai", event({ type: "response.incomplete", response: { status: "incomplete", output_text: "partial", incomplete_details: { reason: "max_output_tokens" } } })],
    ["openai", event({ type: "response.failed", response: { status: "failed", error: { message: "upstream failed" } } })],
    ["openai", event({ type: "response.refusal.delta", delta: "refused" }) + event({ type: "response.completed", response: { status: "completed" } })],
    ["openai", "data: {broken}\n\n"],
    ["gemini", event({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })],
    ["gemini", event({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }] })],
    ["gemini", event({ promptFeedback: { blockReason: "SAFETY" } })],
    ["gemini", event({ error: { message: "quota failed" } })],
])("%s incomplete, refused or malformed streams never become a completed answer (%#)", async (provider, body) => {
    const mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    try { await expect(requestImageQuestion(configs[provider], messages, () => {})).rejects.toBeInstanceOf(Error); }
    finally { mock.mockRestore(); }
});

test("JSON fallback still requires a complete response and surfaces provider errors", async () => {
    const mock = spyOn(globalThis, "fetch");
    try {
        mock.mockResolvedValueOnce(Response.json({ status: "completed", output_text: "done" }));
        expect(await requestImageQuestion(configs.openai, messages, () => {})).toBe("done");
        mock.mockResolvedValueOnce(Response.json({ output_text: "partial" }));
        await expect(requestImageQuestion(configs.openai, messages, () => {})).rejects.toThrow();
        mock.mockResolvedValueOnce(Response.json({ error: { message: "provider detail" } }));
        await expect(requestImageQuestion(configs.openai, messages, () => {})).rejects.toThrow("provider detail");
        mock.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
        expect(await requestImageQuestion(configs.gemini, messages, () => {})).toBe("done");
    } finally { mock.mockRestore(); }
});

test("pre-canceled text requests do not reach the provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = spyOn(globalThis, "fetch");
    try {
        await expect(requestImageQuestion(configs.openai, messages, () => {}, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
        expect(mock).not.toHaveBeenCalled();
    } finally { mock.mockRestore(); }
});
