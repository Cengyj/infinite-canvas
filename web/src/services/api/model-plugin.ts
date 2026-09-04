import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_TIMEOUT_MS } from "@/lib/video-config";
import { buildApiUrl, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

export type PluginHttpOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export type PluginHttp = {
    url: (path: string) => string;
    post: (path: string, body?: unknown, options?: PluginHttpOptions) => Promise<unknown>;
    get: (path: string, options?: PluginHttpOptions) => Promise<unknown>;
};

export type PluginPollOptions = { intervalMs?: number; timeoutMs?: number };

export type RunPluginArgs = {
    capability: ModelCapability;
    script: string;
    config: AiConfig;
    prompt?: string;
    images?: string[];
    messages?: unknown[];
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

function pluginHeaders(extra?: Record<string, string>, hasJsonBody = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasJsonBody) headers["Content-Type"] = "application/json";
    return { ...headers, ...extra };
}

function pluginUrl(config: AiConfig, path: string) {
    if (/^https?:/i.test(path)) return path;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    // Respect an explicitly versioned path so custom scripts can call Gemini's
    // /v1beta endpoints without ending up with /v1/v1beta.
    if (/^\/v1(?:beta)?(?:\/|$)/i.test(normalizedPath)) {
        const baseUrl = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
        return `${baseUrl}${normalizedPath}`;
    }
    return buildApiUrl(config.baseUrl, normalizedPath);
}

function createPluginHttp(config: AiConfig, options?: RequestOptions): PluginHttp {
    const run = async (method: "get" | "post", path: string, body: unknown, opts?: PluginHttpOptions) => {
        const isForm = typeof FormData !== "undefined" && body instanceof FormData;
        const response = await axios.request({
            method,
            url: pluginUrl(config, path),
            data: method === "post" ? body : undefined,
            params: opts?.params,
            headers: pluginHeaders({ Authorization: `Bearer ${config.apiKey}`, ...opts?.headers }, method === "post" && !isForm && body !== undefined),
            responseType: opts?.responseType || "json",
            signal: options?.signal,
        });
        return response.data;
    };
    return {
        url: (path) => pluginUrl(config, path),
        post: (path, body, opts) => run("post", path, body, opts),
        get: (path, opts) => run("get", path, undefined, opts),
    };
}

/** Raw request with no automatic auth header — the script controls method, url, headers, body entirely. */
function createPluginRequest(config: AiConfig, options?: RequestOptions) {
    return async (requestConfig: AxiosRequestConfig & { url: string }) => {
        const response = await axios.request({ ...requestConfig, url: pluginUrl(config, requestConfig.url), signal: options?.signal });
        return response.data;
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        let settled = false;
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => {
            clearTimeout(timer);
            settle(() => reject(new DOMException("Aborted", "AbortError")));
        };
        const timer = setTimeout(() => settle(resolve), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function createPoll(signal?: AbortSignal) {
    return async function poll<T, R>(request: () => Promise<T>, extract: (value: T) => R | null | undefined | false, options?: PluginPollOptions): Promise<R> {
        const intervalMs = options?.intervalMs ?? 2500;
        const timeoutMs = options?.timeoutMs ?? 300000;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
            const result = extract(await request());
            if (result !== null && result !== undefined && result !== false) return result;
            if (performance.now() >= deadline) throw new Error(i18n.t("modelPlugin.pollTimeout"));
            await sleep(intervalMs, signal);
        }
    };
}

/**
 * Run a user-authored model call script as an async function body with flat locals (see PLUGIN_VARIABLES):
 *   prompt / images / messages / params        — request input
 *   model / baseUrl / apiKey / systemPrompt / reasoningEffort     — current channel and text settings
 *   http / request / poll / sleep / signal / onDelta    — request helpers
 * The script must `return` the result; each caller normalizes it to its capability's shape.
 */
export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const { config } = args;
    const http = createPluginHttp(config, { signal: args.signal });
    const request = createPluginRequest(config, { signal: args.signal });
    const poll = createPoll(args.signal);
    const runner = new Function(
        "prompt",
        "images",
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
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (...fnArgs: unknown[]) => Promise<T>;
    try {
        return await runner(
            args.prompt || "",
            args.images || [],
            args.messages || [],
            args.params || {},
            config.model,
            config.baseUrl,
            config.apiKey,
            config.systemPrompt || "",
            config.reasoningEffort,
            http,
            request,
            poll,
            (ms: number) => sleep(ms, args.signal),
            args.signal,
            args.onDelta,
        );
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isCancel(error)) throw error;
        if (axios.isAxiosError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(i18n.t("modelPlugin.executionFailed", { message }));
    }
}

export type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };

/** Documentation surface shown in the script editor. */
export function getPluginVariables(): PluginVariable[] {
    return [
        { name: "prompt", type: "string", desc: i18n.t("modelPlugin.variables.prompt"), capabilities: ["image", "video", "audio"] },
        { name: "images", type: "string[]", desc: i18n.t("modelPlugin.variables.images"), capabilities: ["image", "video", "text"] },
        { name: "messages", type: "{ role, content }[]", desc: i18n.t("modelPlugin.variables.messages"), capabilities: ["text"] },
        { name: "params", type: "object", desc: i18n.t("modelPlugin.variables.params") },
        { name: "model", type: "string", desc: i18n.t("modelPlugin.variables.model") },
        { name: "baseUrl", type: "string", desc: i18n.t("modelPlugin.variables.baseUrl") },
        { name: "apiKey", type: "string", desc: i18n.t("modelPlugin.variables.apiKey") },
        { name: "systemPrompt", type: "string", desc: i18n.t("modelPlugin.variables.systemPrompt") },
        { name: "reasoningEffort", type: '"auto" | "low" | "medium" | "high" | "xhigh"', desc: i18n.t("modelPlugin.variables.reasoningEffort"), capabilities: ["text"] },
        { name: "http", type: "object", desc: i18n.t("modelPlugin.variables.http") },
        { name: "request", type: "function", desc: i18n.t("modelPlugin.variables.request") },
        { name: "poll", type: "function", desc: i18n.t("modelPlugin.variables.poll") },
        { name: "sleep", type: "function", desc: i18n.t("modelPlugin.variables.sleep") },
        { name: "signal", type: "AbortSignal", desc: i18n.t("modelPlugin.variables.signal") },
        { name: "onDelta", type: "function", desc: i18n.t("modelPlugin.variables.onDelta"), capabilities: ["text"] },
    ];
}

export function getPluginReturn(capability: ModelCapability) {
    return i18n.t(`modelPlugin.returns.${capability}`);
}

export type PluginTemplate = { label: string; script: string };

export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    return {
    image: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.imageOpenai")}
// ${i18n.t("modelPlugin.templates.availableImage")}
const readImages = (data) => {
  const apiError = typeof data?.error === "string" ? data.error : data?.error?.message;
  if (apiError) throw new Error(apiError);
  const items = Array.isArray(data?.data) ? data.data : [];
  const output = items.map((item) => item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url).filter(Boolean);
  if (!output.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.noImages"))});
  return output;
};
const count = Math.max(1, Math.min(10, Math.floor(Number(params.count) || 1)));
if (images.length === 0) {
  // ${i18n.t("modelPlugin.templates.textToImage")}
  const data = await http.post("/images/generations", {
    model, prompt, n: count,
    ...(params.size ? { size: params.size } : {}),
    ...(params.quality ? { quality: params.quality } : {}),
    ...(params.background ? { background: params.background } : {}),
  });
  return readImages(data);
}

// ${i18n.t("modelPlugin.templates.imageToImage")}
if (images.length > 16) throw new Error(${JSON.stringify(i18n.t("imageWorkbench.editReferenceLimit", { count: 16 }))});
const form = new FormData();
form.set("model", model);
form.set("prompt", prompt);
form.set("n", String(count));
if (params.size) form.set("size", params.size);
if (params.quality) form.set("quality", params.quality);
if (params.background) form.set("background", params.background);
const imageField = images.length > 1 ? "image[]" : "image";
for (const dataUrl of images) {
  const response = await fetch(dataUrl, { signal });
  if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
  form.append(imageField, await response.blob(), "ref.png");
}
const edited = await http.post("/images/edits", form); // ${i18n.t("modelPlugin.templates.formDataHeader")}
return readImages(edited);`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.imageGemini")}
// ${i18n.t("modelPlugin.templates.availableImageGemini")}
const apiBase = baseUrl.trim().replace(/\\/+$/, "").replace(/\\/v1(?:beta)?$/i, "");
const modelName = encodeURIComponent(String(model).trim().replace(/^models\\//i, ""));
const parts = [{ text: prompt }];
for (const dataUrl of images) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
  parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
}
const data = await request({
  method: "post",
  url: \`\${apiBase}/v1beta/models/\${modelName}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  data: { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } },
});
const apiError = typeof data.error === "string" ? data.error : data.error?.message;
if (apiError) throw new Error(apiError);
if (data.promptFeedback?.blockReason) throw new Error(${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))}.replace("__REASON__", data.promptFeedback.blockReason));
const finishReason = (data.candidates || []).map((candidate) => candidate.finishReason).find((reason) => reason && reason !== "STOP");
if (finishReason) throw new Error(${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))}.replace("__REASON__", finishReason));
const output = (data.candidates || [])
  .flatMap((c) => c.content?.parts || [])
  .map((p) => p.inlineData || p.inline_data)
  .filter((img) => Boolean(img?.data))
  .map((img) => \`data:\${img.mimeType || img.mime_type || "image/png"};base64,\${img.data}\`);
if (!output.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.noImages"))});
return output;`,
        },
    ],
    video: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.videoOpenai")}
if (images.length > 1) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSingleReference"))});
const seconds = String(params.seconds || "").trim();
if (!["4", "8", "12"].includes(seconds)) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSecondsUnsupported"))});
const size = String(params.size || "").trim();
if (size && !["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size)) {
  throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSizeUnsupported"))});
}
const form = new FormData();
form.set("model", model);
form.set("prompt", prompt);
form.set("seconds", seconds);
if (size) form.set("size", size);
if (images[0]) {
  const response = await fetch(images[0], { signal });
  if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
  form.set("input_reference", await response.blob(), "reference.png");
}
const task = await http.post("/videos", form); // ${i18n.t("modelPlugin.templates.formDataHeader")}
const rawTaskId = task?.id || task?.task_id || task?.request_id;
if (!rawTaskId) throw new Error(${JSON.stringify(i18n.t("apiErrors.noVideoTaskId"))});
const taskId = encodeURIComponent(String(rawTaskId));
const completed = await poll(
  () => http.get(\`/videos/\${taskId}\`),
  (state) => {
    const status = String(state.status || "").toLowerCase();
    if (["failed", "fail", "error", "cancelled", "canceled"].includes(status)) {
      const error = typeof state.error === "string" ? state.error : state.error?.message;
      throw new Error(error || state.error_message || state.fail_reason || state.message || ${JSON.stringify(i18n.t("apiErrors.videoGenerationFailed"))});
    }
    const progress = Number(String(state.progress || "").replace(/%$/, ""));
    return ["completed", "complete", "success", "succeeded", "done", "finished"].includes(status) || progress >= 100 ? state : null;
  },
  { intervalMs: ${VIDEO_POLL_INTERVAL_MS}, timeoutMs: ${VIDEO_POLL_TIMEOUT_MS} },
);
const url = completed.video_url || completed.result_url || completed.download_url || completed.url;
return url ? { url } : await http.get(\`/videos/\${taskId}/content\`, { responseType: "blob" });`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.videoGemini")}
// ${i18n.t("modelPlugin.templates.availableVideoGemini")}
if (images.length > 1) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.videoSingleReference"))});
const apiBase = baseUrl.trim().replace(/\\/+$/, "").replace(/\\/v1(?:beta)?$/i, "");
const rawModelName = String(model).trim().replace(/^models\\//i, "");
const modelName = encodeURIComponent(rawModelName);
const headers = { "Content-Type": "application/json", "x-goog-api-key": apiKey };
const instance = { prompt };
const first = images[0] && images[0].match(/^data:([^;]+);base64,(.*)$/);
if (first) instance.image = { bytesBase64Encoded: first[2], mimeType: first[1] };
if (images.length && !first) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
const size = String(params.size || params.ratio || "").trim().toLowerCase();
const dimensions = size.match(/^(\\d+)\\s*[x:]\\s*(\\d+)$/);
if (dimensions && Number(dimensions[1]) === Number(dimensions[2])) {
  throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiVideoSquareUnsupported"))});
}
const aspectRatio = !size || size === "auto" || size === "adaptive" || !dimensions
  ? ""
  : Number(dimensions[1]) > Number(dimensions[2]) ? "16:9" : "9:16";
const isVeo2 = /^veo-2(?:[.-]|$)/i.test(rawModelName);
const seconds = String(params.seconds || "").trim();
const allowedSeconds = isVeo2 ? ["5", "6", "8"] : ["4", "6", "8"];
if (!allowedSeconds.includes(seconds)) {
  throw new Error(isVeo2
    ? ${JSON.stringify(i18n.t("modelPlugin.templates.geminiVeo2SecondsUnsupported"))}
    : ${JSON.stringify(i18n.t("modelPlugin.templates.geminiVeo3SecondsUnsupported"))});
}
const resolution = String(params.resolution || "720p").trim().toLowerCase();
if (!isVeo2 && resolution !== "720p") {
  throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiVeo3ResolutionUnsupported"))});
}
const parameters = {
  durationSeconds: seconds,
  ...(aspectRatio ? { aspectRatio } : {}),
  ...(!isVeo2 ? { resolution: "720p" } : {}),
};
const op = await request({
  method: "post",
  url: \`\${apiBase}/v1beta/models/\${modelName}:predictLongRunning\`,
  headers,
  data: { instances: [instance], parameters },
});
if (!op?.name) throw new Error(${JSON.stringify(i18n.t("apiErrors.noVideoTask"))});
const uri = await poll(
  () => request({ method: "get", url: \`\${apiBase}/v1beta/\${String(op.name).replace(/^\\/+/, "")}\`, headers }),
  (state) => {
    if (!state.done) return null;
    if (state.error) throw new Error(state.error.message || ${JSON.stringify(i18n.t("apiErrors.videoGenerationFailed"))});
    const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiNoVideoUri"))});
    return uri;
  },
  { intervalMs: 5000, timeoutMs: 300000 },
);
return await request({ method: "get", url: uri, headers: { "x-goog-api-key": apiKey }, responseType: "blob" });`,
        },
    ],
    audio: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.audioOpenai")}
return await http.post("/audio/speech", {
  model, input: prompt, voice: params.voice, response_format: params.format, speed: Number(params.speed),
}, { responseType: "blob" });`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.audioGemini")}
// ${i18n.t("modelPlugin.templates.availableAudioGemini")}
const apiBase = baseUrl.trim().replace(/\\/+$/, "").replace(/\\/v1(?:beta)?$/i, "");
const modelName = encodeURIComponent(String(model).trim().replace(/^models\\//i, ""));
const data = await request({
  method: "post",
  url: \`\${apiBase}/v1beta/models/\${modelName}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  data: {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: params.voice } } },
    },
  },
});
const audio = data.candidates?.[0]?.content?.parts?.map((p) => p.inlineData || p.inline_data).find(Boolean);
if (!audio?.data) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.geminiNoAudio"))});
return { data: audio.data };`,
        },
    ],
    text: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `// ${i18n.t("modelPlugin.templates.textOpenai")}
const input = messages.map((message) => ({
  ...message,
  content: Array.isArray(message.content)
    ? message.content.map((part) => part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url.url }
      : { type: "input_text", text: part.text })
    : message.content,
}));
const data = await http.post("/responses", {
  model,
  input,
  store: false,
  ...(reasoningEffort === "auto" ? {} : { reasoning: { effort: reasoningEffort } }),
});
const apiError = typeof data.error === "string" ? data.error : data.error?.message;
if (apiError) throw new Error(apiError);
const incompleteMessage = (reason) => ${JSON.stringify(i18n.t("apiErrors.textResponseIncomplete", { reason: "__REASON__" }))}.replace("__REASON__", String(reason));
if (data.status !== "completed") throw new Error(incompleteMessage(data.incomplete_details?.reason || data.status || "missing_status"));
const content = (data.output || []).flatMap((item) => item.content || []);
const refusal = content.find((item) => item.refusal)?.refusal;
if (refusal) throw new Error(refusal);
const text = data.output_text
  || content.map((item) => item.text || "").join("");
if (!text?.trim()) throw new Error(${JSON.stringify(i18n.t("apiErrors.noContent"))});
onDelta(text);
return text;`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `// ${i18n.t("modelPlugin.templates.textGemini")}
// ${i18n.t("modelPlugin.templates.availableTextGemini")}
const toParts = (content) => (Array.isArray(content) ? content : [{ type: "text", text: content }]).map((part) => {
  if (part.type !== "image_url") return { text: part.text || "" };
  const match = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: part.image_url.url } };
});
const contents = messages
  .filter((m) => m.role !== "system")
  .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toParts(m.content) }));
const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\\n\\n") || systemPrompt;
const apiBase = baseUrl.trim().replace(/\\/+$/, "").replace(/\\/v1(?:beta)?$/i, "");
const modelName = encodeURIComponent(String(model).trim().replace(/^models\\//i, ""));
const data = await request({
  method: "post",
  url: \`\${apiBase}/v1beta/models/\${modelName}:generateContent\`,
  headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  data: { contents, ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}) },
});
const apiError = typeof data.error === "string" ? data.error : data.error?.message;
if (apiError) throw new Error(apiError);
const rejectedMessage = (reason) => ${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))}.replace("__REASON__", String(reason));
if (data.promptFeedback?.blockReason) throw new Error(rejectedMessage(data.promptFeedback.blockReason));
const candidate = data.candidates?.[0];
const finishReason = candidate?.finishReason;
if (finishReason !== "STOP") {
  const reason = finishReason || "missing_finish_reason";
  if (reason === "MAX_TOKENS" || !finishReason) {
    throw new Error(${JSON.stringify(i18n.t("apiErrors.textResponseIncomplete", { reason: "__REASON__" }))}.replace("__REASON__", reason));
  }
  throw new Error(rejectedMessage(reason));
}
const text = candidate.content?.parts?.map((part) => part.text || "").join("") || "";
if (!text.trim()) throw new Error(${JSON.stringify(i18n.t("apiErrors.noContent"))});
onDelta(text);
return text;`,
        },
    ],
    };
}

/** Normalize whatever an image script returns into the app's generated-image shape. */
export function normalizePluginImages(result: unknown): string[] {
    const items = Array.isArray(result) ? result : [result];
    const urls = items
        .map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object") {
                const record = item as Record<string, unknown>;
                if (typeof record.dataUrl === "string") return record.dataUrl;
                if (typeof record.url === "string") return record.url;
                if (typeof record.b64_json === "string") return `data:image/png;base64,${record.b64_json}`;
            }
            return "";
        })
        .filter(Boolean);
    if (!urls.length) throw new Error(i18n.t("modelPlugin.noImages"));
    return urls;
}
