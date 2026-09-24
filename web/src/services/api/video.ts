import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { inferVideoRatio } from "@/lib/media-size";
import { MAX_VIDEO_REFERENCE_IMAGES, VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_TIMEOUT_MS, isGrokVideoModel, normalizeVideoFrameSize, normalizeVideoRatio, normalizeVideoResolutionName, normalizeVideoSeconds } from "@/lib/video-config";
import { classifyNetworkFailure, isAbortError, isBrowserNetworkError, isCrossOriginUrl, isOriginNotAllowedFetchResponse, isOriginNotAllowedResponse, networkFailureMessage } from "@/lib/network-errors";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { appendUrlPath, boolConfig, buildApiUrl, isHttpUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export { MAX_VIDEO_REFERENCE_IMAGES, isGrokVideoModel } from "@/lib/video-config";

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
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type GrokVideoRequest = { model: string; prompt: string; seconds: string; aspect_ratio: string; resolution: string; image?: string; reference_images?: string[] };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; width?: number; height?: number; aspectRatio?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "gemini" | "plugin"; model: string };
type GeminiInlineData = { inlineData: { data: string; mimeType: string } };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
const GROK_VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const COMPLETED_VIDEO_STATUSES = new Set(["completed", "complete", "success", "succeeded", "done", "finished"]);
const FAILED_VIDEO_STATUSES = new Set(["failed", "fail", "error", "cancelled", "canceled"]);

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();
const pluginVideoResultTimers = new Map<VideoGenerationResult, number>();
const PLUGIN_VIDEO_RESULT_TTL_MS = 10 * 60_000;

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        throwIfAborted(options?.signal);
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw videoTaskFailed(state.error);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(VIDEO_POLL_INTERVAL_MS, remainingMs), options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    throwIfAborted(options?.signal);
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, requestPrompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "gemini") return createGeminiVideoTask(requestConfig, selectedModel, requestPrompt, references, options);
    if (isGrokVideoModel(requestConfig.model)) return createGrokVideoTask(requestConfig, selectedModel, requestPrompt, references, options);
    return createOpenAIVideoTask(requestConfig, selectedModel, requestPrompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    throwIfAborted(options?.signal);
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        if (!result) return { status: "failed", error: apiText("pluginVideoExpired") };
        pluginVideoResults.delete(task.id);
        return { status: "completed", result };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "gemini") return pollGeminiVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image, options)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            videos,
            audios,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds, config.model),
                size: normalizeVideoSize(config.size, config.vquality),
                resolution: normalizeVideoResolutionName(config.vquality),
                ratio: normalizeVideoRatio(config.size) || "16:9",
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
                mode: resolveVideoMode(config.videoMode, refs.length),
            },
            signal: options?.signal,
        }),
    );
    if (options?.signal?.aborted) {
        releaseVideoGenerationResult(result);
        throwIfAborted(options.signal);
    }
    const id = nanoid();
    pluginVideoResults.set(id, result);
    pluginVideoResultTimers.set(
        result,
        window.setTimeout(() => {
            if (pluginVideoResults.get(id) === result) pluginVideoResults.delete(id);
            pluginVideoResultTimers.delete(result);
            releaseVideoGenerationResult(result);
        }, PLUGIN_VIDEO_RESULT_TTL_MS),
    );
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        const metadata = { ...videoResponseDimensions(record as VideoResponse), aspectRatio: normalizeVideoRatio(String(record.aspectRatio || record.aspect_ratio || record.size || "")) || undefined };
        if (record.blob instanceof Blob) return { ...metadata, blob: record.blob, mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { ...metadata, url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult, options?: RequestOptions): Promise<UploadedFile> {
    throwIfAborted(options?.signal);
    if (result.blob) {
        const blob = !result.blob.type.startsWith("video/") && result.mimeType?.startsWith("video/") ? result.blob.slice(0, result.blob.size, result.mimeType) : result.blob;
        return applyVideoResultMetadata(await uploadMediaFile(blob, "video", options), result);
    }
    if (result.url) {
        try {
            return applyVideoResultMetadata(await uploadMediaFile(result.url, "video", options), result);
        } catch (error) {
            if (isAbortError(error) || options?.signal?.aborted) throw error;
            if (isObjectUrl(result.url)) throw new Error(apiText("videoDownloadFailed"));
            if (error instanceof Error && ["ERR_PROXY_ORIGIN_NOT_ALLOWED", "ERR_PROXY_UNREACHABLE"].includes(String((error as Error & { code?: unknown }).code))) throw error;
            const requestUrl = withLocalProxy(result.url);
            if (isBrowserNetworkError(error) && requestUrl === result.url && isCrossOriginUrl(result.url)) {
                return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4", width: result.width, height: result.height, aspectRatio: result.aspectRatio };
            }
            throw new Error(apiText("videoDownloadFailed"));
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

/** Releases temporary URLs returned by scripted video plugins. Safe to call more than once. */
export function releaseVideoGenerationResult(result: VideoGenerationResult | undefined) {
    if (!result) return;
    const timer = pluginVideoResultTimers.get(result);
    if (timer !== undefined) {
        window.clearTimeout(timer);
        pluginVideoResultTimers.delete(result);
    }
    if (result.url && isObjectUrl(result.url)) URL.revokeObjectURL(result.url);
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, options) })));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    body.append("size", normalizeVideoSize(config.size, config.vquality) || "1280x720");
    body.append("resolution_name", normalizeVideoResolutionName(config.vquality));
    body.append("generate_audio", String(boolConfig(config.videoGenerateAudio, true)));
    body.append("watermark", String(boolConfig(config.videoWatermark, false)));
    body.append("mode", mode);
    if (mode === "frames") {
        if (images[0]) body.append("first_frame", images[0], "first.png");
        if (images[1]) body.append("last_frame", images[1], "last.png");
    } else {
        images.forEach((file) => body.append("image[]", file, "ref.png"));
    }
    videos.forEach((file) => body.append("video[]", file));
    audios.forEach((file) => body.append("audio[]", file));
    return submitOpenAIVideoTask(config, model, body, options);
}

async function createGrokVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (references.length > MAX_VIDEO_REFERENCE_IMAGES) throw new Error(apiText("videoReferenceLimit", { count: MAX_VIDEO_REFERENCE_IMAGES }));
    if (options?.videos?.length || options?.audios?.length) throw new Error(i18n.t("grokVideo.mediaReferenceUnsupported"));
    const body: GrokVideoRequest = {
        model: modelOptionName(model),
        prompt,
        seconds: String(grokVideoDuration(config.videoSeconds)),
        aspect_ratio: grokVideoAspectRatio(config.size),
        resolution: grokVideoResolution(modelOptionName(model), config.vquality, references.length),
    };
    const images = await Promise.all(references.map((image) => imageToDataUrl(image, options)));
    if (images.length === 1) body.image = images[0];
    if (images.length > 1) body.reference_images = images;
    return submitOpenAIVideoTask(config, model, body, options);
}

async function submitOpenAIVideoTask(config: AiConfig, model: string, body: FormData | GrokVideoRequest, options?: RequestOptions): Promise<VideoGenerationTask> {
    let requestUrl = "";
    try {
        throwIfAborted(options?.signal);
        requestUrl = aiApiUrl(config, "/videos");
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(requestUrl, body, { headers: aiHeaders(config, body instanceof FormData ? undefined : "application/json"), signal: options?.signal })).data);
        const taskId = videoTaskId(created);
        if (!taskId) throw new Error(readApiErrorMessage(created) || apiText("noVideoTaskId"));
        return { id: taskId, provider: "openai", model };
    } catch (error) {
        if (isAbortError(error) || axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed"), requestUrl));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    let requestUrl = "";
    try {
        const taskPath = `/videos/${encodeURIComponent(task.id)}`;
        requestUrl = aiApiUrl(config, taskPath);
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(requestUrl, { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = videoStatus(video);
        if (FAILED_VIDEO_STATUSES.has(status)) return { status: "failed", error: readApiErrorMessage(video) || apiText("videoGenerationFailed") };
        const url = videoResultUrl(video);
        if (url) {
            const resolvedUrl = resolveVideoUrl(config, url);
            const headers = isAuthenticatedVideoContentUrl(config, resolvedUrl) ? aiHeaders(config) : undefined;
            return { status: "completed", result: enrichVideoResult(config, video, await videoResultFromUrl(resolvedUrl, options, headers)) };
        }
        if (COMPLETED_VIDEO_STATUSES.has(status) || videoProgress(video) >= 100) {
            requestUrl = aiApiUrl(config, `${taskPath}/content`);
            const content = await axios.get<Blob>(requestUrl, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: enrichVideoResult(config, video, { blob: content.data }) };
        }
        return { status: "pending" };
    } catch (error) {
        if (isAbortError(error) || axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed"), requestUrl));
    }
}

function grokVideoDuration(value: string) {
    const duration = Number(value);
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error(i18n.t("grokVideo.durationUnsupported"));
    return duration;
}

function grokVideoAspectRatio(value: string) {
    const mapped = ({ "1792x1024": "3:2", "1024x1792": "2:3" } as Record<string, string>)[value];
    const ratio = mapped || normalizeVideoRatio(value);
    if (!ratio && (!value || ["auto", "adaptive"].includes(value))) return "16:9";
    if (GROK_VIDEO_ASPECT_RATIOS.has(ratio)) return ratio;
    // Pixel sizes such as 854x480 are rounded to even integers by the workbench.
    if (/^\d+x\d+$/i.test(value)) {
        const [width, height] = value.toLowerCase().split("x").map(Number);
        const matched = [...GROK_VIDEO_ASPECT_RATIOS].find((item) => {
            const [w, h] = item.split(":").map(Number);
            return Math.abs(width / height - w / h) < 0.005;
        });
        if (matched) return matched;
    }
    throw new Error(i18n.t("grokVideo.aspectRatioUnsupported"));
}

function grokVideoResolution(model: string, value: string, referenceCount: number) {
    const raw = String(value || "auto").trim().toLowerCase();
    const qualityTier = raw === "low" ? "480p" : ["auto", "medium", "high"].includes(raw) ? "720p" : `${raw.replace(/p$/, "")}p`;
    if (!["480p", "720p", "1080p"].includes(qualityTier)) throw new Error(i18n.t("grokVideo.resolutionUnsupported"));
    if (qualityTier === "1080p" && (!/^grok-imagine-video-1\.5(?:$|-)/i.test(model) || referenceCount > 1)) throw new Error(i18n.t("grokVideo.resolutionCombinationUnsupported"));
    return qualityTier;
}

function enrichVideoResult(config: AiConfig, response: VideoResponse, result: VideoGenerationResult): VideoGenerationResult {
    const grok = isGrokVideoModel(config.model);
    const aspectRatio = videoResponseAspectRatio(response) || (grok ? grokVideoAspectRatio(config.size) : normalizeVideoRatio(config.size)) || undefined;
    return { ...videoResponseDimensions(response), ...(grok ? { mimeType: "video/mp4" } : {}), aspectRatio, ...result };
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
    const dimensions = file.width && file.height ? { width: file.width, height: file.height } : { width: result.width, height: result.height };
    return { ...file, ...dimensions, aspectRatio: result.aspectRatio };
}

function resolveVideoUrl(config: AiConfig, value: string) {
    const base = new URL(config.baseUrl);
    const pathname = base.pathname.replace(/\/+$/, "");
    if (!/\/v1(?:beta)?$/i.test(pathname)) base.pathname = `${pathname}/v1`;
    return new URL(value.trim(), appendUrlPath(base.toString(), "/")).toString();
}

function isAuthenticatedVideoContentUrl(config: AiConfig, value: string) {
    const target = new URL(value);
    return target.origin === new URL(config.baseUrl).origin && /\/videos\/[^/]+\/content\/?$/i.test(target.pathname);
}

async function videoResultFromUrl(url: string, options?: RequestOptions, headers?: Record<string, string>): Promise<VideoGenerationResult> {
    const requestUrl = withLocalProxy(url);
    try {
        const response = await axios.get<Blob>(requestUrl, { headers, responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (!canFallbackToPublicVideoUrl(url, headers, error, requestUrl)) throw new Error(readAxiosError(error, apiText("videoDownloadFailed"), requestUrl));
        return { url, mimeType: "video/mp4" };
    }
}

export function canFallbackToPublicVideoUrl(url: string, headers?: Record<string, string>, error?: unknown, requestUrl = url) {
    if (error === undefined) return !headers && isPublicMediaUrl(url);
    return !headers && isPublicMediaUrl(url) && isCrossOriginUrl(url) && requestUrl === url && isBrowserNetworkError(error);
}

async function createGeminiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image, options)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const instance: Record<string, unknown> = { prompt };
    if (mode === "frames") {
        if (images[0]) instance.image = parseDataUrlInline(images[0]);
        if (images[1]) instance.lastFrame = parseDataUrlInline(images[1]);
    } else {
        instance.referenceImages = images.map((dataUrl) => ({ image: parseDataUrlInline(dataUrl), referenceType: "asset" }));
    }
    if (videos[0]) instance.video = await fileToGeminiInline(videos[0]);
    if (audios[0]) instance.audio = await fileToGeminiInline(audios[0]);
    let requestUrl = "";
    try {
        requestUrl = geminiVideoUrl(config, model, "predictLongRunning");
        const created = unwrapEnvelope((await axios.post<ApiEnvelope<GeminiVideoOperation>>(requestUrl, {
            instances: [instance],
            parameters: {
                aspectRatio: videoAspectRatio(config.size),
                durationSeconds: Number(normalizeVideoSeconds(config.videoSeconds)) || 8,
                resolution: normalizeVideoResolutionName(config.vquality),
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                addWatermark: boolConfig(config.videoWatermark, false),
            },
        }, { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("noVideoTask"));
        if (!created.name) throw new Error(apiText("noVideoTaskId"));
        return { id: created.name, provider: "gemini", model };
    } catch (error) {
        if (isAbortError(error) || axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed"), requestUrl));
    }
}

async function pollGeminiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    let requestUrl = "";
    try {
        requestUrl = geminiOperationUrl(config, task.id);
        const state = unwrapEnvelope((await axios.get<ApiEnvelope<GeminiVideoOperation>>(requestUrl, { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("videoTaskQueryFailed"));
        if (state.error) return { status: "failed", error: readApiErrorMessage(state.error.message) || apiText("videoGenerationFailed") };
        if (!state.done) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return { status: "failed", error: apiText("noPlayableVideo") };
        const resolvedUrl = new URL(uri, geminiVideoBaseUrl(config)).toString();
        const sameProvider = isSameOrigin(resolvedUrl, geminiVideoBaseUrl(config));
        const safeUrl = sameProvider ? stripSensitiveQuery(resolvedUrl) : resolvedUrl;
        const headers = sameProvider ? { "x-goog-api-key": config.apiKey } : undefined;
        return { status: "completed", result: { aspectRatio: normalizeVideoRatio(config.size) || undefined, ...await videoResultFromUrl(safeUrl, options, headers) } };
    } catch (error) {
        if (isAbortError(error) || axios.isCancel(error) || options?.signal?.aborted) throw error;
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed"), requestUrl));
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

function geminiVideoBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const rawBaseUrl = config.baseUrl.trim();
    try {
        const base = new URL(rawBaseUrl);
        base.hash = "";
        const pathname = base.pathname.replace(/\/+$/, "");
        if (!/\/v1(?:beta)?$/i.test(pathname)) base.pathname = `${pathname}/v1beta` || "/v1beta";
        return base.toString();
    } catch {
        const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
        const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
        return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
    }
}

function geminiVideoUrl(config: Pick<AiConfig, "baseUrl">, model: string, action: string) {
    return withLocalProxy(appendUrlPath(geminiVideoBaseUrl(config), `/models/${encodeURIComponent(modelOptionName(model).replace(/^models\//, ""))}:${action}`));
}

function geminiOperationUrl(config: Pick<AiConfig, "baseUrl">, name: string) {
    const baseUrl = geminiVideoBaseUrl(config);
    const rawName = name.trim();
    if (isHttpUrl(rawName)) {
        const resolvedUrl = new URL(rawName, baseUrl).toString();
        if (!isSameOrigin(resolvedUrl, baseUrl)) throw new Error("Gemini returned an operation URL on a different host");
        return withLocalProxy(stripSensitiveQuery(resolvedUrl));
    }
    const relative = rawName.replace(/^\/+/, "").replace(/^v1beta\//i, "").replace(/^v1\//i, "");
    return withLocalProxy(appendUrlPath(baseUrl, `/${relative}`));
}

function geminiVideoHeaders(config: Pick<AiConfig, "apiKey">) {
    return { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
}

function isSameOrigin(value: string, baseUrl: string) {
    try {
        return new URL(value, baseUrl).origin === new URL(baseUrl).origin;
    } catch {
        return false;
    }
}

function stripSensitiveQuery(value: string) {
    try {
        const url = new URL(value);
        for (const key of Array.from(url.searchParams.keys())) {
            if (["key", "api_key", "apikey", "token", "access_token", "auth", "authorization"].includes(key.toLowerCase())) url.searchParams.delete(key);
        }
        return url.toString();
    } catch {
        return value;
    }
}

function videoAspectRatio(size: string) {
    const ratio = inferVideoRatio(size);
    return ratio === "auto" ? "16:9" : ratio;
}

export function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { inlineData: { data: match?.[2] || "", mimeType: match?.[1] || fallbackType } };
}

async function fileToGeminiInline(file: File): Promise<GeminiInlineData> {
    return parseDataUrlInline(await readFileAsDataUrl(file), file.type || "application/octet-stream");
}

async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    throwIfAborted(options?.signal);
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        const requestUrl = withLocalProxy(url);
        try {
            const response = await fetch(requestUrl, { signal: options?.signal });
            if (!response.ok) {
                if (await isOriginNotAllowedFetchResponse(response, requestUrl)) throw new Error(i18n.t("config.proxy.originNotAllowed"));
                throw new Error(apiText("httpFailed", { status: response.status }));
            }
            blob = await response.blob();
        } catch (error) {
            if (isAbortError(error)) throw error;
            const kind = classifyNetworkFailure(error, requestUrl);
            if (kind === "cors") throw new Error(apiText("corsRequired"));
            if (kind === "proxy") throw new Error(i18n.t("config.proxy.unreachable"));
            if (kind === "network") throw new Error(apiText("requestFailed"));
            throw error instanceof Error ? error : new Error(apiText(errorKey));
        }
    }
    throwIfAborted(options?.signal);
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    const size = normalizeVideoFrameSize(value, resolution);
    return size === "auto" ? null : size;
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
    return direct !== undefined ? String(direct).trim() : nestedVideoResponses(payload).map(videoTaskId).find(Boolean) || "";
}

function videoStatus(payload: VideoResponse): string {
    if (typeof payload.status === "string" && payload.status.trim()) return payload.status.trim().toLowerCase();
    return nestedVideoResponses(payload).map(videoStatus).find(Boolean) || "";
}

function videoProgress(payload: VideoResponse): number {
    const value = typeof payload.progress === "string" ? Number(payload.progress.replace(/%$/, "")) : Number(payload.progress);
    return Number.isFinite(value) ? value : Math.max(0, ...nestedVideoResponses(payload).map(videoProgress));
}

function videoResultUrl(payload: VideoResponse): string | undefined {
    const direct = [payload.video_url, payload.result_url, payload.download_url, payload.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || url.startsWith("/") || /\.(?:mp4|mov|webm|m3u8)(?:\?|#|$)/i.test(url)));
    return direct?.trim() || nestedVideoResponses(payload).map(videoResultUrl).find(Boolean);
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

function readAxiosError(error: unknown, fallback: string, requestUrl = "") {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return networkFailureMessage(error, requestUrl || String(error.config?.url || ""), { cors: apiText("corsRequired"), proxy: i18n.t("config.proxy.unreachable"), fallback: apiText("requestFailed") });
        const responseData = error.response?.data;
        if (isOriginNotAllowedResponse(error.response, String(error.config?.url || requestUrl))) return i18n.t("config.proxy.originNotAllowed");
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (isAbortError(error)) return apiText("requestCanceled");
    if (isBrowserNetworkError(error) && requestUrl) return networkFailureMessage(error, requestUrl, { cors: apiText("corsRequired"), proxy: i18n.t("config.proxy.unreachable"), fallback: apiText("requestFailed") });
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
    return isHttpUrl(value || "");
}

function isObjectUrl(value: string) {
    return /^blob:/i.test(value);
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
