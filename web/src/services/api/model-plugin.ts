import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_TIMEOUT_MS } from "@/lib/video-config";
import { classifyNetworkFailure, isAbortError, isBrowserNetworkError, isOriginNotAllowedFetchResponse, isOriginNotAllowedResponse, networkFailureMessage } from "@/lib/network-errors";
import { appendUrlPath, buildApiUrl, isHttpUrl, withLocalProxy, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type RequestOptions = { signal?: AbortSignal };

export type PluginHttpOptions = {
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    responseType?: "json" | "blob" | "text" | "arraybuffer";
};

export type PluginHttp = {
    url: (path: string, apiVersion?: "v1" | "v1beta") => string;
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
    videos?: File[];
    audios?: File[];
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

function pluginUrl(config: AiConfig, path: string, apiVersion: "v1" | "v1beta" = "v1") {
    if (isHttpUrl(path)) return withLocalProxy(path);
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    if (/^\/v1(?:beta)?(?:\/|$)/i.test(normalizedPath)) {
        const base = new URL(config.baseUrl);
        base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
        return withLocalProxy(appendUrlPath(base.toString(), normalizedPath));
    }
    return buildApiUrl(config.baseUrl, normalizedPath, apiVersion);
}

function pluginRequestUrl(config: AiConfig, path: string) {
    if (isHttpUrl(path)) return withLocalProxy(path);
    return withLocalProxy(appendUrlPath(config.baseUrl, path.startsWith("/") ? path : `/${path}`));
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
        url: (path, apiVersion) => pluginUrl(config, path, apiVersion),
        post: (path, body, opts) => run("post", path, body, opts),
        get: (path, opts) => run("get", path, undefined, opts),
    };
}

/** Raw request with no automatic auth header — the script controls method, url, headers, body entirely. */
function createPluginRequest(config: AiConfig, options?: RequestOptions) {
    return async (requestConfig: AxiosRequestConfig & { url: string }) => {
        const response = await axios.request({ ...requestConfig, url: pluginRequestUrl(config, requestConfig.url), signal: options?.signal });
        return response.data;
    };
}

/** Give custom scripts the same proxy-aware fetch used by the built-in helpers. */
function createPluginFetch(signal?: AbortSignal) {
    return (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        const requestUrl = withLocalProxy(rawUrl);
        const request = typeof input === "string" || input instanceof URL ? requestUrl : requestUrl !== rawUrl ? new Request(requestUrl, input) : input;
        const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const combinedSignal = signal && requestSignal ? AbortSignal.any([signal, requestSignal]) : signal || requestSignal;
        return fetch(request, combinedSignal ? { ...init, signal: combinedSignal } : init).then(async (response) => {
            if (await isOriginNotAllowedFetchResponse(response, requestUrl)) throw new Error(i18n.t("config.proxy.originNotAllowed"));
            return response;
        }).catch((error) => {
            if (isAbortError(error)) throw error;
            if (isBrowserNetworkError(error)) {
                throw new Error(networkFailureMessage(error, requestUrl, {
                    cors: i18n.t("apiErrors.corsRequired"),
                    proxy: i18n.t("config.proxy.unreachable"),
                    fallback: i18n.t("apiErrors.requestFailed"),
                }));
            }
            throw error;
        });
    };
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
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
            await sleep(Math.min(intervalMs, Math.max(0, deadline - performance.now())), signal);
        }
    };
}

/**
 * Run a user-authored model call script. Locals are injected (see PLUGIN_VARIABLES); templates wrap them in an async function.
 * The script still runs as an async function body and must `return` the result.
 */
export async function runModelPlugin<T = unknown>(args: RunPluginArgs): Promise<T> {
    const { config } = args;
    const http = createPluginHttp(config, { signal: args.signal });
    const request = createPluginRequest(config, { signal: args.signal });
    const pluginFetch = createPluginFetch(args.signal);
    const poll = createPoll(args.signal);
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
        "fetch",
        `"use strict"; return (async () => {\n${args.script}\n})();`,
    ) as (...fnArgs: unknown[]) => Promise<T>;
    try {
        return await runner(
            args.prompt || "",
            args.images || [],
            args.videos || [],
            args.audios || [],
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
            pluginFetch,
        );
    } catch (error) {
        if (isAbortError(error)) throw error;
        if (axios.isCancel(error)) throw error;
        if (axios.isAxiosError(error) && isOriginNotAllowedResponse(error.response, String(error.config?.url || ""))) {
            throw new Error(i18n.t("config.proxy.originNotAllowed"));
        }
        const requestUrl = axios.isAxiosError(error) ? String(error.config?.url || "") : "";
        if (isBrowserNetworkError(error)) {
            const kind = classifyNetworkFailure(error, requestUrl);
            if (kind === "cors") throw new Error(i18n.t("apiErrors.corsRequired"));
            if (kind === "proxy") throw new Error(i18n.t("config.proxy.unreachable"));
            if (kind === "network") throw new Error(i18n.t("apiErrors.requestFailed"));
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(i18n.t("modelPlugin.executionFailed", { message }));
    }
}

export type PluginVariable = { name: string; type: string; desc: string; capabilities?: ModelCapability[] };

/** Documentation surface shown in the script editor. */
export function getPluginVariables(): PluginVariable[] {
    return [
        { name: "prompt", type: "string", desc: i18n.t("modelPlugin.variables.prompt"), capabilities: ["image", "video", "audio"] },
        { name: "images", type: "string[]", desc: i18n.t("modelPlugin.variables.images"), capabilities: ["image", "video"] },
        { name: "videos", type: "File[]", desc: i18n.t("modelPlugin.variables.videos"), capabilities: ["video"] },
        { name: "audios", type: "File[]", desc: i18n.t("modelPlugin.variables.audios"), capabilities: ["video"] },
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
        { name: "fetch", type: "function", desc: i18n.t("modelPlugin.variables.fetch") },
    ];
}

export function getPluginReturn(capability: ModelCapability) {
    return i18n.t(`modelPlugin.returns.${capability}`);
}

export function getPluginAuthoringPrompt(capability: ModelCapability, modelName: string, draft = "") {
    const variables = getPluginVariables().filter((variable) => !variable.capabilities || variable.capabilities.includes(capability));
    const lines = [
        i18n.t("modelPlugin.authoring.intro", { capability: i18n.t(`config.channelEditor.capabilities.${capability}`), model: modelName || i18n.t("modelPlugin.authoring.anyModel") }),
        "",
        i18n.t("modelPlugin.authoring.shape"),
        "",
        i18n.t("modelPlugin.authoring.returnTitle"),
        getPluginReturn(capability),
        "",
        i18n.t("modelPlugin.authoring.variablesTitle"),
        ...variables.map((variable) => `- ${variable.name} (${variable.type}): ${variable.desc}`),
        "",
        i18n.t("modelPlugin.authoring.rulesTitle"),
        i18n.t("modelPlugin.authoring.rules"),
    ];
    const templates = getPluginTemplates()[capability];
    if (templates.length) {
        lines.push("", i18n.t("modelPlugin.authoring.examplesTitle"));
        for (const template of templates) {
            lines.push("", `${template.label}`, template.script);
        }
    }
    if (draft.trim()) {
        lines.push("", i18n.t("modelPlugin.authoring.draftTitle"), draft.trim());
    }
    return lines.join("\n");
}

export type PluginTemplate = { label: string; script: string };

export function getPluginTemplates(): Record<ModelCapability, PluginTemplate[]> {
    const openaiVideoPolling = `
  const unwrap = (value) => {
    if (value && value.code !== undefined) {
      if (![0, "0", 200, "200"].includes(value.code)) throw new Error(value.error?.message || value.message || value.msg || "video request failed");
      return value.data;
    }
    return value;
  };
  const created = unwrap(task);
  const rawId = created?.id ?? created?.task_id ?? created?.request_id ?? created?.data?.id;
  if (rawId === undefined || rawId === null || !String(rawId).trim()) throw new Error(${JSON.stringify(i18n.t("apiErrors.noVideoTaskId"))});
  const taskId = encodeURIComponent(String(rawId));
  return await poll(async () => {
    const state = unwrap(await request({ method: "get", url: http.url("/videos/" + taskId), headers }));
    const status = String(state?.status || state?.data?.status || "").trim().toLowerCase();
    if (["failed", "fail", "error", "cancelled", "canceled"].includes(status)) {
      const failure = state.error || state.data?.error;
      throw new Error((typeof failure === "string" ? failure : failure?.message) || state.error_message || state.fail_reason || state.message || ${JSON.stringify(i18n.t("apiErrors.videoGenerationFailed"))});
    }
    const output = state.video || state.content || state.output || state.data || state;
    const url = state.video_url || state.result_url || state.download_url || state.url || output.video_url || output.result_url || output.download_url || output.url;
    if (url) {
      const provider = new URL(baseUrl);
      if (!/\\/v1(?:beta)?\\/?$/i.test(provider.pathname)) provider.pathname = provider.pathname.replace(/\\/+$/, "") + "/v1";
      provider.pathname = provider.pathname.replace(/\\/+$/, "") + "/";
      const resolved = new URL(url, provider);
      if (resolved.origin === provider.origin && /\\/videos\\/[^/]+\\/content\\/?$/i.test(resolved.pathname)) {
        return await request({ method: "get", url: resolved.toString(), headers, responseType: "blob" });
      }
      return { url: resolved.toString(), width: output.width || state.width, height: output.height || state.height, aspectRatio: output.aspect_ratio || state.aspect_ratio };
    }
    const progress = Number(String(state.progress ?? state.data?.progress ?? "").replace(/%$/, ""));
    if (["completed", "complete", "success", "succeeded", "done", "finished"].includes(status) || progress >= 100) {
      return await request({ method: "get", url: http.url("/videos/" + taskId + "/content"), headers, responseType: "blob" });
    }
    return null;
  }, (result) => result, { intervalMs: ${VIDEO_POLL_INTERVAL_MS}, timeoutMs: ${VIDEO_POLL_TIMEOUT_MS} });`;
    return {
    image: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `/**
 * OpenAI image generation and editing.
 * Text-to-image uses POST /v1/images/generations (JSON) when images is empty.
 * Image editing uses POST /v1/images/edits (multipart) when images has data URLs.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs; empty for text-to-image
 * @param {object} params
 * @param {string} params.size - output size, e.g. "1024x1024" or "auto"
 * @param {string} params.quality - "low" | "medium" | "high"
 * @param {number} params.count - number of images
 * @param {string} [params.background] - "transparent" when requested
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request - raw HTTP helper; relative urls join baseUrl without /v1
 * @returns {Promise<string[]>} image URLs or data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    quality,
    count,
    background,
  },
  model,
  apiKey,
  http,
  request,
}) {
  count = Math.max(1, Math.min(10, Math.floor(Number(count) || 1)));
  if (images.length > 16) throw new Error(${JSON.stringify(i18n.t("imageWorkbench.editReferenceLimit", { count: 16 }))});
  const isGptImage = /gpt-image/i.test(model);
  if (images.length === 0) {
    const data = await request({
      method: "post",
      url: http.url("/images/generations"),
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${apiKey}\`,
      },
      data: {
        model: model,
        prompt: prompt,
        n: count,
        ...(size ? { size: size } : {}),
        ...(quality ? { quality: quality } : {}),
        ...(isGptImage && background ? { background: background } : {}),
        ...(isGptImage ? { output_format: "png" } : { response_format: "b64_json" }),
      },
    });
    const apiError = typeof data.error === "string" ? data.error : data.error?.message;
    if (apiError) throw new Error(apiError);
    const urls = [];
    for (const item of data.data || []) {
      urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
    }
    return urls;
  }

  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("n", String(count));
  if (size) form.set("size", size);
  if (quality) form.set("quality", quality);
  if (isGptImage && background) form.set("background", background);
  if (isGptImage) form.set("output_format", "png");
  else form.set("response_format", "b64_json");
  const imageField = images.length > 1 ? "image[]" : "image";
  for (const dataUrl of images) {
    const source = typeof dataUrl === "string" && /^(?:https?:\\/\\/|\\/\\/)/i.test(dataUrl) ? http.url(dataUrl) : dataUrl;
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
    form.append(imageField, await response.blob(), "ref.png");
  }
  const edited = await request({
    method: "post",
    url: http.url("/images/edits"),
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: form,
  });
  const apiError = typeof edited.error === "string" ? edited.error : edited.error?.message;
  if (apiError) throw new Error(apiError);
  const urls = [];
  for (const item of edited.data || []) {
    urls.push(item.b64_json ? \`data:image/png;base64,\${item.b64_json}\` : item.url);
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  apiKey,
  http,
  request,
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `/**
 * Gemini image generation via models/{model}:generateContent.
 * Reference images go into parts.inlineData. size maps to the closest supported aspectRatio;
 * quality maps to imageSize only for models that support image-size configuration.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {object} params
 * @param {string} params.size - normalized legacy script size, usually pixel dimensions
 * @param {string} [params.requestedSize] - original Gemini size before generic script-size normalization
 * @param {string} params.quality - "low" | "medium" | "high"; sent as imageSize when supported
 * @param {number} params.count - number of generateContent calls
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<string[]>} image data URLs
 */
async function generateImage({
  prompt,
  images,
  params: {
    size,
    requestedSize,
    quality,
    count,
  },
  model,
  apiKey,
  http,
  request,
}) {
  const parts = [{ text: prompt }];
  for (const dataUrl of images) {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      parts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2],
        },
      });
    }
  }

  const modelName = String(model || "").trim().replace(/^models\\//, "").replace(/-preview$/i, "").toLowerCase();
  const modelProfiles = {
    "gemini-3.1-flash-image": { imageSizes: ["512", "1K", "2K", "4K"], extended: true },
    "gemini-3.1-flash-lite-image": { imageSizes: ["1K"], extended: true },
    "gemini-3-pro-image": { imageSizes: ["1K", "2K", "4K"], extended: false },
    "gemini-2.5-flash-image": { extended: false },
  };
  const profile = modelProfiles[modelName] || null;
  const standardRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
  const ratios = profile && profile.extended ? standardRatios.concat(["1:4", "1:8", "4:1", "8:1"]) : standardRatios;
  const parseRatio = (value) => {
    const match = String(value || "").match(/^(\\d+(?:\\.\\d+)?)[x:](\\d+(?:\\.\\d+)?)$/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
  };
  const closestAspectRatio = (value) => {
    const target = parseRatio(value);
    if (!target) return "1:1";
    return ratios.reduce((best, current) => Math.abs(parseRatio(current) - target) < Math.abs(parseRatio(best) - target) ? current : best);
  };
  const imageSizeMap = {
    low: "1K",
    medium: "2K",
    high: "4K",
    standard: "1K",
    hd: "2K",
  };
  const presetImageSizeByDimensions = {
    "1024x1024": "1K", "1024x1536": "1K", "1536x1024": "1K", "1024x768": "1K", "768x1024": "1K", "1536x864": "1K", "864x1536": "1K", "2016x864": "1K", "864x2016": "1K",
    "2048x2048": "2K", "1360x2048": "2K", "2048x1360": "2K", "2048x1536": "2K", "1536x2048": "2K", "2048x1152": "2K", "1152x2048": "2K", "2688x1152": "2K", "1152x2688": "2K",
    "2880x2880": "4K", "2336x3520": "4K", "3520x2336": "4K", "3312x2480": "4K", "2480x3312": "4K", "3840x2160": "4K", "2160x3840": "4K", "3840x1648": "4K", "1648x3840": "4K",
  };
  const geminiSize = requestedSize || size;
  const aspectRatio = geminiSize && geminiSize !== "auto" ? closestAspectRatio(geminiSize) : undefined;
  const dimensions = String(geminiSize || "").match(/^(\\d+)x(\\d+)$/i);
  const dimensionKey = dimensions ? Number(dimensions[1]) + "x" + Number(dimensions[2]) : String(geminiSize || "").toLowerCase();
  const requestedImageSize = imageSizeMap[String(quality || "").toLowerCase()]
    || presetImageSizeByDimensions[dimensionKey]
    || (dimensions
      ? (() => {
          const edge = Math.max(Number(dimensions[1]), Number(dimensions[2]));
          return edge <= 768 ? "512" : edge <= 1536 ? "1K" : edge <= 3072 ? "2K" : "4K";
        })()
      : undefined);
  const supportedImageSizes = profile && profile.imageSizes;
  if (requestedImageSize && supportedImageSizes && !supportedImageSizes.includes(requestedImageSize)) {
    throw new Error("Gemini model " + model + " does not support " + requestedImageSize + "; supported sizes: " + supportedImageSizes.join(", "));
  }
  const imageSize = requestedImageSize && supportedImageSizes ? requestedImageSize : undefined;
  const imageConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
  const generationConfig = {
    responseModalities: ["TEXT", "IMAGE"],
    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
  };
  const n = Number(count) || 1;
  const urls = [];

  for (let i = 0; i < n; i++) {
    const data = await request({
      method: "post",
      url: http.url("/models/" + encodeURIComponent(String(model || "").replace(/^models\\//i, "")) + ":generateContent", "v1beta"),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      data: {
        contents: [
          {
            role: "user",
            parts: parts,
          },
        ],
        generationConfig: generationConfig,
      },
    });
    const apiError = typeof data.error === "string" ? data.error : data.error?.message;
    if (apiError) throw new Error(apiError);
    const rejected = data.promptFeedback?.blockReason || (data.candidates || []).map((candidate) => candidate.finishReason).find((reason) => reason && reason !== "STOP");
    if (rejected) throw new Error(${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))}.replace("__REASON__", rejected));
    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        const img = part.inlineData || part.inline_data;
        if (img && img.data) {
          urls.push(\`data:\${img.mimeType || img.mime_type || "image/png"};base64,\${img.data}\`);
        }
      }
    }
  }
  return urls;
}

return await generateImage({
  prompt,
  images,
  params,
  model,
  apiKey,
  http,
  request,
});`,
        },
    ],
    video: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `/**
 * OpenAI-compatible video: POST /v1/videos (multipart), then poll GET /v1/videos/{id}.
 * Do not set Content-Type on FormData; the browser adds the boundary.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" uses first/last frame fields; "reference" sends all images as references. More than 2 images become "reference".
 * @param {string|number} params.seconds - duration
 * @param {string} params.size - output size, e.g. "1280x720"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}|Blob>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    generateAudio,
    watermark,
  },
  model,
  apiKey,
  http,
  request,
  poll,
}) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("seconds", String(seconds || 8));
  form.set("size", String(size || "1280x720"));
  form.set("resolution_name", String(resolution || "720p"));
  form.set("generate_audio", String(generateAudio !== false));
  form.set("watermark", String(watermark === true));
  form.set("mode", mode);
  if (mode === "frames") {
    if (images[0]) {
      const source = typeof images[0] === "string" && /^(?:https?:\\/\\/|\\/\\/)/i.test(images[0]) ? http.url(images[0]) : images[0];
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
      form.append("first_frame", await response.blob(), "first.png");
    }
    if (images[1]) {
      const source = typeof images[1] === "string" && /^(?:https?:\\/\\/|\\/\\/)/i.test(images[1]) ? http.url(images[1]) : images[1];
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
      form.append("last_frame", await response.blob(), "last.png");
    }
  } else {
    for (const dataUrl of images) {
      const source = typeof dataUrl === "string" && /^(?:https?:\\/\\/|\\/\\/)/i.test(dataUrl) ? http.url(dataUrl) : dataUrl;
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(${JSON.stringify(i18n.t("apiErrors.referenceImageReadFailed"))});
      form.append("image[]", await response.blob(), "ref.png");
    }
  }
  for (const file of videos) {
    form.append("video[]", file);
  }
  for (const file of audios) {
    form.append("audio[]", file);
  }

  const headers = {
    Authorization: \`Bearer \${apiKey}\`,
  };
  const task = await request({
    method: "post",
    url: http.url("/videos"),
    headers,
    data: form,
  });

  ${openaiVideoPolling}
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  apiKey,
  http,
  request,
  poll,
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `/**
 * Gemini Veo video: POST models/{model}:predictLongRunning, then poll the operation.
 * First/last-frame mode: images[0] -> image, images[1] -> lastFrame.
 * Reference mode: all images -> referenceImages.
 * @param {string} prompt
 * @param {string[]} images - reference images as data URLs
 * @param {File[]} videos - reference videos; empty when none
 * @param {File[]} audios - reference audio; empty when none
 * @param {object} params
 * @param {string} params.mode - "frames" or "reference"
 * @param {string|number} params.seconds - sent as durationSeconds
 * @param {string} params.size - pixel size; mapped to aspectRatio when needed
 * @param {string} params.ratio - aspect ratio, e.g. "16:9"
 * @param {string} params.resolution - e.g. "720p"
 * @param {boolean} params.generateAudio
 * @param {boolean} params.watermark - sent as addWatermark
 * @param {string} model
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {object} http
 * @param {AbortSignal} signal
 * @param {function} request
 * @param {function} poll
 * @returns {Promise<{url: string}|Blob>}
 */
async function generateVideo({
  prompt,
  images,
  videos,
  audios,
  params: {
    mode,
    seconds,
    size,
    resolution,
    ratio,
    generateAudio,
    watermark,
  },
  model,
  baseUrl,
  apiKey,
  http,
  signal,
  request,
  poll,
}) {
  async function toInline(source) {
    if (typeof source === "string") {
      const match = source.match(/^data:([^;]+);base64,(.*)$/);
      return {
        inlineData: {
          data: match ? match[2] : "",
          mimeType: match ? match[1] : "image/png",
        },
      };
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(source);
    });
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    return {
      inlineData: {
        data: match ? match[2] : "",
        mimeType: match ? match[1] : (source.type || "application/octet-stream"),
      },
    };
  }

  function geminiBaseUrl(value) {
    const normalized = String(value || "").trim();
    try {
      const url = new URL(normalized);
      url.hash = "";
      const pathname = url.pathname.replace(/\\/+$/, "");
      if (!/\\/v1(?:beta)?$/i.test(pathname)) url.pathname = (pathname || "") + "/v1beta";
      return url.toString();
    } catch {
      const fallback = normalized.replace(/\\/+$/, "");
      return /\\/v1(?:beta)?$/i.test(fallback) ? fallback : fallback + "/v1beta";
    }
  }

  function appendGeminiPath(base, path) {
    const url = new URL(base);
    const suffix = new URL(path, url.origin);
    const basePath = url.pathname.replace(/\\/+$/, "");
    const suffixPath = suffix.pathname.replace(/^\\/+/, "");
    url.pathname = (basePath || "") + "/" + suffixPath;
    if (suffix.search) {
      const params = new URLSearchParams(url.search);
      suffix.searchParams.forEach((value, key) => params.append(key, value));
      url.search = params.toString();
    }
    url.hash = "";
    return url.toString();
  }

  function geminiModelName(value) {
    return String(value || "").trim().replace(/^models\\//i, "");
  }

  const providerBaseUrl = geminiBaseUrl(baseUrl);
  function sameOrigin(value) {
    try {
      return new URL(value, providerBaseUrl).origin === new URL(providerBaseUrl).origin;
    } catch {
      return false;
    }
  }

  function withoutApiKey(value) {
    try {
      const url = new URL(value, providerBaseUrl);
      const sensitiveNames = new Set(["key", "api_key", "apikey", "token", "access_token", "auth", "authorization"]);
      for (const name of Array.from(url.searchParams.keys())) {
        if (sensitiveNames.has(name.toLowerCase())) url.searchParams.delete(name);
      }
      return url.toString();
    } catch {
      return value;
    }
  }

  function geminiOperationUrl(value) {
    const name = String(value || "").trim();
    if (!name) throw new Error("Gemini did not return an operation name");
    if (/^(?:https?:\\/\\/|\\/\\/)/i.test(name)) {
      if (!sameOrigin(name)) throw new Error("Gemini returned an operation URL on a different host");
      return withoutApiKey(name);
    }
    const relative = name.replace(/^\\/+/, "").replace(/^v1beta\\//i, "").replace(/^v1\\//i, "");
    return appendGeminiPath(providerBaseUrl, "/" + relative);
  }

  const ratioOptions = ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9"];
  function parseRatio(value) {
    const match = String(value || "").match(/^(\\d+(?:\\.\\d+)?)[x:](\\d+(?:\\.\\d+)?)$/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
  }
  function closestRatio(value) {
    const target = parseRatio(value);
    if (!target) return "16:9";
    return ratioOptions.reduce((best, current) => Math.abs(parseRatio(current) - target) < Math.abs(parseRatio(best) - target) ? current : best);
  }
  const requestedRatio = ratio && ratio !== "auto" ? ratio : size;
  const aspectRatio = requestedRatio && requestedRatio !== "auto" ? closestRatio(requestedRatio) : "16:9";

  const instance = {
    prompt: prompt,
  };
  if (mode === "frames") {
    if (images[0]) {
      instance.image = await toInline(images[0]);
    }
    if (images[1]) {
      instance.lastFrame = await toInline(images[1]);
    }
  } else {
    instance.referenceImages = [];
    for (const dataUrl of images) {
      instance.referenceImages.push({
        image: await toInline(dataUrl),
        referenceType: "asset",
      });
    }
  }
  if (videos[0]) {
    instance.video = await toInline(videos[0]);
  }
  if (audios[0]) {
    instance.audio = await toInline(audios[0]);
  }

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
  const op = await request({
    method: "post",
    url: appendGeminiPath(providerBaseUrl, "/models/" + encodeURIComponent(geminiModelName(model)) + ":predictLongRunning"),
    headers,
    data: {
      instances: [instance],
      parameters: {
        aspectRatio: aspectRatio,
        durationSeconds: Number(seconds) || 8,
        resolution: resolution || "720p",
        generateAudio: generateAudio !== false,
        addWatermark: watermark === true,
      },
    },
  });
  if (!op || typeof op.name !== "string" || !op.name.trim()) {
    throw new Error("Gemini did not return an operation name");
  }

  const result = await poll(
    () => request({ method: "get", url: geminiOperationUrl(op.name), headers }),
    (state) => {
      if (state.error) {
        throw new Error(state.error.message || "video generation failed");
      }
      if (!state.done) return null;
      const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new Error("Gemini did not return a video URI");
      return { url: uri };
    },
    { intervalMs: ${VIDEO_POLL_INTERVAL_MS}, timeoutMs: ${VIDEO_POLL_TIMEOUT_MS} },
  );
  const resultUrl = new URL(result.url, providerBaseUrl).toString();
  if (!/^https?:\\/\\//i.test(resultUrl)) return result;
  const sameProvider = sameOrigin(resultUrl);
  const safeUrl = withoutApiKey(resultUrl);
  try {
    return await request({
      method: "get",
      // Preserve CDN signatures; only provider URLs use the configured API key.
      url: sameProvider ? safeUrl : resultUrl,
      headers: sameProvider ? { "x-goog-api-key": apiKey } : {},
      responseType: "blob",
    });
  } catch (error) {
    const crossOrigin = typeof location !== "undefined" && new URL(resultUrl).origin !== location.origin;
    if (!sameProvider && crossOrigin && !signal?.aborted && error?.code === "ERR_NETWORK" && http.url(resultUrl) === resultUrl) return { url: resultUrl };
    throw error;
  }
}

return await generateVideo({
  prompt,
  images,
  videos,
  audios,
  params,
  model,
  baseUrl,
  apiKey,
  http,
  signal,
  request,
  poll,
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.openaiStandard"),
            script: `// OpenAI Sora: standard multipart fields, with one optional input_reference.
if (images.length > 1 || videos.length || audios.length) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSingleReference"))});
const seconds = String(params.seconds || "").trim();
if (!["4", "8", "12"].includes(seconds)) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSecondsUnsupported"))});
const size = String(params.size || "").trim();
if (size && !["720x1280", "1280x720", "1024x1792", "1792x1024"].includes(size)) throw new Error(${JSON.stringify(i18n.t("modelPlugin.templates.openaiVideoSizeUnsupported"))});
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
const headers = { Authorization: \`Bearer \${apiKey}\` };
const task = await request({ method: "post", url: http.url("/videos"), headers, data: form });
${openaiVideoPolling}`,
        },
    ],
    audio: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `/**
 * OpenAI speech: POST /v1/audio/speech.
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice
 * @param {string} params.format - response_format, e.g. "mp3"
 * @param {string|number} params.speed
 * @param {string} [params.instructions] - voice style instructions
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<Blob>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
    format,
    speed,
    instructions,
  },
  model,
  apiKey,
  http,
  request,
}) {
  return await request({
    method: "post",
    url: http.url("/audio/speech"),
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    responseType: "blob",
    data: {
      model: model,
      input: prompt,
      voice: voice,
      response_format: format,
      speed: Number(speed),
      instructions: instructions,
    },
  });
}

return await generateAudio({
  prompt,
  params,
  model,
  apiKey,
  http,
  request,
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `/**
 * Gemini TTS: POST models/{model}:generateContent with AUDIO modality.
 * Audio bytes are returned in inlineData.data (base64 PCM).
 * @param {string} prompt - text to speak
 * @param {object} params
 * @param {string} params.voice - prebuilt voice name
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request
 * @returns {Promise<{data: string}>}
 */
async function generateAudio({
  prompt,
  params: {
    voice,
  },
  model,
  apiKey,
  http,
  request,
}) {
  const data = await request({
    method: "post",
    url: http.url("/models/" + encodeURIComponent(String(model || "").replace(/^models\\//i, "")) + ":generateContent", "v1beta"),
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    },
  });
  const parts = data.candidates?.[0]?.content?.parts || [];
  let audio = null;
  for (const part of parts) {
    audio = part.inlineData || part.inline_data;
    if (audio && audio.data) break;
  }
  if (!audio || !audio.data) throw new Error("Gemini did not return audio");
  return { data: audio.data };
}

return await generateAudio({
  prompt,
  params,
  model,
  apiKey,
  http,
  request,
});`,
        },
    ],
    text: [
        {
            label: i18n.t("modelPlugin.templates.openai"),
            script: `/**
 * OpenAI text: POST /v1/responses.
 * @param {{role: string, content: string}[]} messages - includes the system message when present
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {string} reasoningEffort - "auto" | "low" | "medium" | "high" | "xhigh"; omit reasoning when "auto"
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  model,
  apiKey,
  reasoningEffort,
  http,
  request,
  onDelta,
}) {
  const body = {
    model: model,
    input: messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content) ? message.content.map((part) => part.type === "image_url"
        ? { type: "input_image", image_url: part.image_url.url }
        : { type: "input_text", text: part.text }) : message.content,
    })),
    store: false,
  };
  if (reasoningEffort && reasoningEffort !== "auto") {
    body.reasoning = {
      effort: reasoningEffort,
    };
  }
  const data = await request({
    method: "post",
    url: http.url("/responses"),
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${apiKey}\`,
    },
    data: body,
  });
  const apiError = typeof data.error === "string" ? data.error : data.error?.message;
  if (apiError) throw new Error(apiError);
  if (data.status !== "completed") throw new Error(${JSON.stringify(i18n.t("apiErrors.textResponseIncomplete", { reason: "__REASON__" }))}.replace("__REASON__", data.incomplete_details?.reason || data.status || "missing_status"));
  const content = (data.output || []).flatMap((item) => item.content || []);
  const refusal = content.find((item) => item.refusal)?.refusal;
  if (refusal) throw new Error(refusal);
  const text = data.output_text || content.map((item) => item.text || "").join("");
  if (!text.trim()) throw new Error(${JSON.stringify(i18n.t("apiErrors.noContent"))});
  onDelta?.(text);
  return text;
}

return await generateText({
  messages,
  model,
  apiKey,
  reasoningEffort,
  http,
  request,
  onDelta,
});`,
        },
        {
            label: i18n.t("modelPlugin.templates.gemini"),
            script: `/**
 * Gemini text: POST models/{model}:generateContent.
 * System messages are skipped in contents; systemPrompt goes to systemInstruction.
 * @param {{role: string, content: string}[]} messages
 * @param {string} systemPrompt
 * @param {string} model
 * @param {object} http
 * @param {string} apiKey
 * @param {function} request
 * @param {function} onDelta - push streaming text
 * @returns {Promise<string>}
 */
async function generateText({
  messages,
  systemPrompt,
  model,
  apiKey,
  http,
  request,
  onDelta,
}) {
  const toParts = (content) => (Array.isArray(content) ? content : [{ type: "text", text: content }]).map((part) => {
    if (part.type !== "image_url") return { text: part.text || "" };
    const match = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
    return match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: part.image_url.url } };
  });
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: toParts(message.content),
    });
  }
  const body = {
    contents: contents,
  };
  const systemText = messages.filter((message) => message.role === "system").map((message) => message.content).join("\\n\\n") || systemPrompt;
  if (systemText) {
    body.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }
  const data = await request({
    method: "post",
    url: http.url("/models/" + encodeURIComponent(String(model || "").replace(/^models\\//i, "")) + ":generateContent", "v1beta"),
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    data: body,
  });
  const apiError = typeof data.error === "string" ? data.error : data.error?.message;
  if (apiError) throw new Error(apiError);
  const candidate = data.candidates?.[0];
  const rejected = data.promptFeedback?.blockReason;
  if (rejected) throw new Error(${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))}.replace("__REASON__", rejected));
  if (candidate?.finishReason !== "STOP") {
    const reason = candidate?.finishReason || "missing_finish_reason";
    const message = !candidate?.finishReason || reason === "MAX_TOKENS"
      ? ${JSON.stringify(i18n.t("apiErrors.textResponseIncomplete", { reason: "__REASON__" }))}
      : ${JSON.stringify(i18n.t("apiErrors.geminiRejected", { reason: "__REASON__" }))};
    throw new Error(message.replace("__REASON__", reason));
  }
  const text = (candidate.content?.parts || []).filter((part) => !part.thought).map((part) => part.text || "").join("");
  if (!text.trim()) throw new Error(${JSON.stringify(i18n.t("apiErrors.noContent"))});
  onDelta?.(text);
  return text;
}

return await generateText({
  messages,
  systemPrompt,
  model,
  apiKey,
  http,
  request,
  onDelta,
});`,
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
