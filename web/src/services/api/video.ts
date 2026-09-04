import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { dataUrlToFile } from "@/lib/image-utils";
import { VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_TIMEOUT_MS, normalizeVideoFrameSize, normalizeVideoRatio, normalizeVideoResolutionName, normalizeVideoSeconds } from "@/lib/video-config";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";

type VideoResponse = {
    id?: string | number;
    task_id?: string | number;
    request_id?: string | number;
    status?: string;
    progress?: number | string;
    width?: number | string;
    height?: number | string;
    size?: string;
    aspect_ratio?: string;
    resolution?: string;
    error?: unknown;
    error_message?: unknown;
    fail_reason?: unknown;
    message?: unknown;
    msg?: unknown;
    detail?: unknown;
    url?: string;
    result_url?: string;
    video_url?: string;
    download_url?: string;
    content?: VideoResponse | null;
    video?: VideoResponse | null;
    output?: VideoResponse | null;
    data?: VideoResponse | VideoResponse[] | null;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
type GrokVideoRequest = { model: string; prompt: string; seconds: string; aspect_ratio: string; resolution: string; image?: string; reference_images?: string[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; width?: number; height?: number; aspectRatio?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
export const MAX_VIDEO_REFERENCE_IMAGES = 7;
const GROK_VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const COMPLETED_VIDEO_STATUSES = new Set(["completed", "complete", "success", "succeeded", "done", "finished"]);
const FAILED_VIDEO_STATUSES = new Set(["failed", "fail", "error", "cancelled", "canceled"]);

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, options);
    return waitForVideoGenerationTask(config, task, options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        throwIfAborted(options?.signal);
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(VIDEO_POLL_INTERVAL_MS, remainingMs), options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (references.length > MAX_VIDEO_REFERENCE_IMAGES) throw new Error(apiText("videoReferenceLimit", { count: MAX_VIDEO_REFERENCE_IMAGES }));
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, requestPrompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "openai" && isGrokVideoModel(requestConfig.model)) return createGrokVideoTask(requestConfig, selectedModel, requestPrompt, references, options);
    if (references.length > 1) throw new Error(apiText("videoReferenceLimit", { count: 1 }));
    return createOpenAIVideoTask(requestConfig, selectedModel, requestPrompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        if (result) pluginVideoResults.delete(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image, options?.signal)));
    try {
        const result = videoPluginResult(
            await runModelPlugin({
                capability: "video",
                script,
                config,
                prompt,
                images: refs,
                params: {
                    seconds: normalizeVideoSeconds(config.videoSeconds),
                    size: normalizeVideoFrameSize(config.size),
                    resolution: normalizeVideoResolutionName(config.vquality),
                    ratio: normalizeVideoRatio(config.size),
                    generateAudio: boolConfig(config.videoGenerateAudio, true),
                    watermark: boolConfig(config.videoWatermark, false),
                },
                signal: options?.signal,
            }),
        );
        const id = nanoid();
        pluginVideoResults.set(id, result);
        return { id, provider: "plugin", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoGenerationFailed")));
    }
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) {
        const blob = !result.blob.type.startsWith("video/") && result.mimeType?.startsWith("video/") ? result.blob.slice(0, result.blob.size, result.mimeType) : result.blob;
        return applyVideoResultMetadata(await uploadMediaFile(blob, "video"), result);
    }
    if (result.url) {
        try {
            return applyVideoResultMetadata(await uploadMediaFile(result.url, "video"), result);
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4", width: result.width, height: result.height, aspectRatio: result.aspectRatio };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    const size = normalizeVideoFrameSize(config.size);
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (size !== "auto") body.append("size", size);
    const files = await readVideoReferenceFiles(references, options?.signal);
    if (files[0]) body.append("input_reference", files[0]);
    return submitOpenAIVideoTask(config, model, body, options);
}

async function createGrokVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image, options?.signal)));
    const body: GrokVideoRequest = {
        model: modelOptionName(model),
        prompt,
        seconds: String(grokVideoDuration(config.videoSeconds)),
        aspect_ratio: grokVideoAspectRatio(config.size),
        resolution: grokVideoResolution(modelOptionName(model), config.vquality, images.length),
    };
    if (images.length === 1) body.image = images[0];
    if (images.length > 1) body.reference_images = images;
    return submitOpenAIVideoTask(config, model, body, options);
}

async function readVideoReferenceFiles(references: ReferenceImage[], signal?: AbortSignal) {
    return Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, signal) })));
}

async function submitOpenAIVideoTask(config: AiConfig, model: string, body: FormData | GrokVideoRequest, options?: RequestOptions): Promise<VideoGenerationTask> {
    try {
        const contentType = body instanceof FormData ? undefined : "application/json";
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config, contentType), signal: options?.signal })).data);
        const taskId = videoTaskId(created);
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
        return { id: taskId, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

function isGrokVideoModel(model: string) {
    return /^grok-imagine-video(?:$|-)/i.test(model.trim());
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const taskPath = `/videos/${encodeURIComponent(task.id)}`;
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, taskPath), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = videoStatus(video);
        if (isFailedVideoStatus(status)) return { status: "failed", error: readApiErrorMessage(video) || apiText("videoGenerationFailed") };
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: enrichVideoResult(config, video, await videoResultFromUrl(config, url, options)) };
        if (isCompletedVideoStatus(status) || videoProgress(video) >= 100) {
            const content = await axios.get<Blob>(aiApiUrl(config, `${taskPath}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: enrichVideoResult(config, video, { blob: content.data }) };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function grokVideoDuration(value: string) {
    const duration = Number(value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error(i18n.t("grokVideo.durationUnsupported"));
    return duration;
}

function grokVideoAspectRatio(value: string) {
    const mapped = {
        "1792x1024": "3:2",
        "1024x1792": "2:3",
    }[value];
    const ratio = mapped || normalizeVideoRatio(value);
    if (!ratio) return "16:9";
    if (!GROK_VIDEO_ASPECT_RATIOS.has(ratio)) throw new Error(i18n.t("grokVideo.aspectRatioUnsupported"));
    return ratio;
}

function grokVideoResolution(model: string, value: string, referenceCount: number) {
    const qualityTier = normalizeVideoResolutionName(value).toLowerCase();
    if (qualityTier !== "480p" && qualityTier !== "720p" && qualityTier !== "1080p") throw new Error(i18n.t("grokVideo.resolutionUnsupported"));
    if (qualityTier === "1080p" && (!/^grok-imagine-video-1\.5(?:$|-)/i.test(model) || referenceCount > 1)) throw new Error(i18n.t("grokVideo.resolutionCombinationUnsupported"));
    return qualityTier;
}

function enrichVideoResult(config: AiConfig, response: VideoResponse, result: VideoGenerationResult): VideoGenerationResult {
    const grok = isGrokVideoModel(config.model);
    const responseDimensions = videoResponseDimensions(response);
    const aspectRatio = videoResponseAspectRatio(response) || (grok ? grokVideoAspectRatio(config.size) : normalizeVideoRatio(config.size)) || undefined;
    return { ...responseDimensions, ...(grok ? { mimeType: "video/mp4" } : {}), aspectRatio, ...result };
}

function videoResponseDimensions(response: VideoResponse): { width: number; height: number } | undefined {
    const width = Number(response.width);
    const height = Number(response.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return { width: Math.round(width), height: Math.round(height) };
    return nestedVideoResponses(response).map(videoResponseDimensions).find(Boolean);
}

function videoResponseAspectRatio(response: VideoResponse): string {
    const direct = [response.aspect_ratio, response.size].map((value) => normalizeVideoRatio(value || "")).find(Boolean);
    return direct || nestedVideoResponses(response).map(videoResponseAspectRatio).find(Boolean) || "";
}

function nestedVideoResponses(response: VideoResponse) {
    return [response.content, response.video, response.output, ...(Array.isArray(response.data) ? response.data : [response.data])].filter(
        (item): item is VideoResponse => Boolean(item) && typeof item === "object",
    );
}

function applyVideoResultMetadata(file: UploadedFile, result: VideoGenerationResult): UploadedFile {
    const responseDimensions = result.width && result.height ? { width: result.width, height: result.height } : {};
    const dimensions = file.width && file.height ? { width: file.width, height: file.height } : responseDimensions;
    return { ...file, ...dimensions, aspectRatio: result.aspectRatio };
}

async function videoResultFromUrl(config: AiConfig, url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    const resolvedUrl = resolveVideoUrl(config, url);
    const requiresAuthorization = isAuthenticatedVideoContentUrl(config, resolvedUrl);
    try {
        const response = await axios.get<Blob>(resolvedUrl, { headers: requiresAuthorization ? aiHeaders(config) : undefined, responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (requiresAuthorization || !axios.isAxiosError(error) || error.response) throw new Error(readAxiosError(error, apiText("videoDownloadFailed")));
        return { url: resolvedUrl, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (![0, "0", 200, "200"].includes(payload.code)) throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoTaskId(payload: VideoResponse): string {
    const direct = [payload.id, payload.task_id, payload.request_id].find((value) => (typeof value === "string" && value.trim()) || typeof value === "number");
    if (direct !== undefined) return String(direct).trim();
    if (Array.isArray(payload.data)) return payload.data.map(videoTaskId).find(Boolean) || "";
    return payload.data ? videoTaskId(payload.data) : "";
}

function videoStatus(payload: VideoResponse): string {
    if (typeof payload.status === "string") return payload.status.trim().toLowerCase();
    if (Array.isArray(payload.data)) return payload.data.map(videoStatus).find(Boolean) || "";
    return payload.data ? videoStatus(payload.data) : "";
}

function videoProgress(payload: VideoResponse): number {
    const value = typeof payload.progress === "string" ? Number(payload.progress.replace(/%$/, "")) : Number(payload.progress);
    if (Number.isFinite(value)) return value;
    if (Array.isArray(payload.data)) return Math.max(0, ...payload.data.map(videoProgress));
    return payload.data ? videoProgress(payload.data) : 0;
}

function videoResultUrl(payload: VideoResponse): string | undefined {
    const direct = [payload.video_url, payload.result_url, payload.download_url, payload.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || isRelativeMediaUrl(url)));
    if (direct) return direct.trim();
    return nestedVideoResponses(payload).map(videoResultUrl).find(Boolean);
}

function isCompletedVideoStatus(status: string) {
    return COMPLETED_VIDEO_STATUSES.has(status);
}

function isFailedVideoStatus(status: string) {
    return FAILED_VIDEO_STATUSES.has(status);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (Array.isArray(value)) return value.map(readApiErrorMessage).find(Boolean) || "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; error_message?: unknown; fail_reason?: unknown; detail?: unknown; data?: unknown };
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(payload.error) ||
        readApiErrorMessage(payload.error_message) ||
        readApiErrorMessage(payload.fail_reason) ||
        readApiErrorMessage(payload.detail) ||
        readApiErrorMessage(payload.data) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("corsRequired");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.size) throw new Error(apiText("videoDownloadFailed"));
    const contentType = blob.type.toLowerCase();
    if (!contentType.includes("json") && !contentType.startsWith("text/") && !contentType.includes("html") && !contentType.includes("xml")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        throw new Error(apiText("videoDownloadFailed"));
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
    throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value.trim());
}

function isRelativeMediaUrl(value: string) {
    const normalized = value.trim();
    return normalized.startsWith("/") || /\.(?:mp4|mov|webm|m3u8)(?:\?|#|$)/i.test(normalized);
}

function resolveVideoUrl(config: AiConfig, value: string) {
    const normalized = value.trim();
    if (isPublicMediaUrl(normalized)) return normalized;
    try {
        return new URL(normalized, aiApiUrl(config, "/")).toString();
    } catch {
        return normalized;
    }
}

function isAuthenticatedVideoContentUrl(config: AiConfig, value: string) {
    try {
        const apiUrl = new URL(aiApiUrl(config, "/"));
        const targetUrl = new URL(value);
        return apiUrl.origin === targetUrl.origin && /\/videos\/[^/]+\/content\/?$/i.test(targetUrl.pathname);
    } catch {
        return false;
    }
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal) {
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
