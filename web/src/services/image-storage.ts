import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { isHttpUrl, withLocalProxy } from "@/stores/use-config-store";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { classifyNetworkFailure, isAbortError, isCrossOriginUrl, isOriginNotAllowedFetchResponse } from "@/lib/network-errors";
import { readRetainedMediaReferences, retainMediaReferences, shouldDeferMediaCleanup } from "@/services/media-references";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const previewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
const previewPending = new Map<string, number>();
const previewGenerations = new Map<string, number>();
const imageWriteIntents = new Map<string, number>();
const activeWrites = new Set<string>();
let mutationRevision = 0;
let imageWriteRevision = 0;
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();
const IMAGE_PREVIEW_VERSION = 1;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";
const IMAGE_CORS_ERROR = "ImageCorsError";
const IMAGE_NETWORK_ERROR = "ImageNetworkError";
const IMAGE_PROXY_ERROR = "ImageProxyError";

type StoredImagePreview = { version: number; blob?: Blob };

type ImageReadOptions = { signal?: AbortSignal };

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        const requestUrl = withLocalProxy(input);
        if (options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || isNamedError(error, IMAGE_PROXY_ERROR) || !isHttpUrl(input)) throw error;
        if ((!isNamedError(error, IMAGE_CORS_ERROR) && !isNamedError(error, IMAGE_NETWORK_ERROR)) || requestUrl !== input || !isCrossOriginUrl(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    return storeImage(blob, options);
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (!blob.size) throw new Error(i18n.t("common.imageReadFailed"));
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    const generation = invalidateImagePreview(storageKey);
    activeWrites.add(storageKey);
    try {
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        await enqueuePreviewWork(async () => {
            await store.setItem(storageKey, blob);
            if (!isCurrentPreview(storageKey, generation)) return;
            await storeImagePreview(storageKey, blob, generation);
        });
        throwIfAborted(options?.signal);
        objectUrls.set(storageKey, url);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        await deleteStoredImages([storageKey]);
        throw error;
    } finally {
        if (isCurrentPreview(storageKey, generation)) activeWrites.delete(storageKey);
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const requestUrl = withLocalProxy(url);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (!response.ok) {
            if (await isOriginNotAllowedFetchResponse(response, requestUrl)) throw namedError(IMAGE_PROXY_ERROR, i18n.t("config.proxy.originNotAllowed"));
            throw namedError(IMAGE_RESPONSE_ERROR);
        }
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted || isAbortError(error)) throw abortReason(options?.signal);
        const kind = classifyNetworkFailure(error, requestUrl);
        if (kind === "cors") throw namedError(IMAGE_CORS_ERROR, i18n.t("apiErrors.corsRequired"));
        if (kind === "proxy") throw namedError(IMAGE_PROXY_ERROR, i18n.t("config.proxy.unreachable"));
        if (kind === "network") throw namedError(IMAGE_NETWORK_ERROR, i18n.t("apiErrors.requestFailed"));
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            if (!value) image.src = "";
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            image.src = "";
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string, message = i18n.t("common.imageReadFailed")) {
    const error = new Error(message);
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal?: AbortSignal) {
    return signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const generation = currentPreviewGeneration(storageKey);
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob || !isCurrentPreview(storageKey, generation)) return fallback;
    const latest = objectUrls.get(storageKey);
    if (latest) return latest;
    const url = URL.createObjectURL(blob);
    if (!isCurrentPreview(storageKey, generation)) {
        URL.revokeObjectURL(url);
        return objectUrls.get(storageKey) || fallback;
    }
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(storageKey) : undefined;
}

// 缩略图在后台补，生成完成后再让用到它的界面重渲染一次。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

function currentPreviewGeneration(storageKey: string) {
    return previewGenerations.get(storageKey) || 0;
}

function isCurrentPreview(storageKey: string, generation: number) {
    return currentPreviewGeneration(storageKey) === generation;
}

function enqueuePreviewWork<T>(work: () => Promise<T> | T) {
    const task = previewQueue.then(work);
    previewQueue = task.catch(() => undefined);
    return task;
}

export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey) return undefined;
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const generation = currentPreviewGeneration(storageKey);
    const stored = await previewStore.getItem<StoredImagePreview>(storageKey).catch(() => null);
    if (!isCurrentPreview(storageKey, generation)) return undefined;
    if (stored?.version === IMAGE_PREVIEW_VERSION && stored.blob) return cacheImagePreview(storageKey, stored.blob, generation);
    queueImagePreview(storageKey, generation);
    return undefined;
}

// 缩略图生成排成一队，避免一次打开大量图片时同时解码。
function queueImagePreview(storageKey: string, generation = currentPreviewGeneration(storageKey)) {
    if (previewPending.get(storageKey) === generation || previewUrls.has(storageKey)) return;
    previewPending.set(storageKey, generation);
    void enqueuePreviewWork(async () => {
        try {
            if (!isCurrentPreview(storageKey, generation) || previewUrls.has(storageKey)) return;
            const original = await getImageBlob(storageKey);
            if (!original || !isCurrentPreview(storageKey, generation)) return;
            const stored = await previewStore.getItem<StoredImagePreview>(storageKey).catch(() => null);
            if (stored?.version === IMAGE_PREVIEW_VERSION && !stored.blob && isCurrentPreview(storageKey, generation)) await previewStore.removeItem(storageKey).catch(() => undefined);
            if (isCurrentPreview(storageKey, generation)) await storeImagePreview(storageKey, original, generation);
        } finally {
            if (previewPending.get(storageKey) === generation) previewPending.delete(storageKey);
        }
    }).catch(() => undefined);
}

async function storeImagePreview(storageKey: string, original: Blob, generation = currentPreviewGeneration(storageKey)) {
    if (!isCurrentPreview(storageKey, generation)) return undefined;
    let preview: Blob | undefined;
    try {
        preview = await createImageThumbnail(original);
    } catch {
        return undefined;
    }
    if (!preview || !isCurrentPreview(storageKey, generation)) return undefined;
    await previewStore.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    if (!isCurrentPreview(storageKey, generation)) return undefined;
    return cacheImagePreview(storageKey, preview, generation);
}

function cacheImagePreview(storageKey: string, preview: Blob, generation = currentPreviewGeneration(storageKey)) {
    if (!isCurrentPreview(storageKey, generation)) return undefined;
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const url = URL.createObjectURL(preview);
    if (!isCurrentPreview(storageKey, generation)) {
        URL.revokeObjectURL(url);
        return undefined;
    }
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(storageKey: string, skipActive = false) {
    if (skipActive && activeWrites.has(storageKey)) return;
    const generation = skipActive ? currentPreviewGeneration(storageKey) : invalidateImagePreview(storageKey);
    await enqueuePreviewWork(async () => {
        if (!isCurrentPreview(storageKey, generation) || (skipActive && (activeWrites.has(storageKey) || collectImageStorageKeys(readRetainedMediaReferences()).has(storageKey)))) return;
        if (skipActive) invalidateImagePreview(storageKey);
        await previewStore.removeItem(storageKey).catch(() => undefined);
    });
}

function invalidateImagePreview(storageKey: string) {
    const generation = ++mutationRevision;
    previewGenerations.set(storageKey, generation);
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    return generation;
}

export async function setImageBlob(storageKey: string, blob: Blob, options?: ImageReadOptions) {
    if (!blob.size) throw new Error(i18n.t("common.imageReadFailed"));
    const writeIntent = ++imageWriteRevision;
    imageWriteIntents.set(storageKey, writeIntent);
    activeWrites.add(storageKey);
    const url = URL.createObjectURL(blob);
    const release = retainMediaReferences(() => [storageKey]);
    let generation: number | undefined;
    let committed = false;
    const isCurrentWrite = () => imageWriteIntents.get(storageKey) === writeIntent;
    const currentUrl = () => objectUrls.get(storageKey) || "";
    try {
        if (!await loadImageMeta(url, options)) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        // A newer upload or an explicit delete wins while this image was decoding.
        if (!isCurrentWrite()) return currentUrl();
        generation = invalidateImagePreview(storageKey);
        await enqueuePreviewWork(async () => {
            if (!isCurrentWrite() || !isCurrentPreview(storageKey, generation!)) return;
            await store.setItem(storageKey, blob);
            if (!isCurrentWrite() || !isCurrentPreview(storageKey, generation!)) return;
            await previewStore.removeItem(storageKey).catch(() => undefined);
            await storeImagePreview(storageKey, blob, generation);
        });
        if (!isCurrentWrite() || !isCurrentPreview(storageKey, generation!)) return currentUrl();
        const previousUrl = objectUrls.get(storageKey);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        objectUrls.set(storageKey, url);
        committed = true;
        return url;
    } catch (error) {
        throw error;
    } finally {
        if (!committed) URL.revokeObjectURL(url);
        if (isCurrentWrite()) {
            activeWrites.delete(storageKey);
            imageWriteIntents.delete(storageKey);
        }
        release();
    }
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    throwIfAborted(options?.signal);
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    throwIfAborted(options?.signal);
    if (!url || url.startsWith("data:")) return url;
    const blob = await fetchImageBlob(url, options);
    if (!blob.size || (blob.type && blob.type !== "application/octet-stream" && !blob.type.startsWith("image/"))) throw new Error(i18n.t("common.imageReadFailed"));
    return blobToDataUrl(blob, options?.signal);
}

export async function deleteStoredImages(keys: Iterable<string>, skipActive = false) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (skipActive && activeWrites.has(key)) return;
            const releaseUrls = () => {
                const url = objectUrls.get(key);
                if (url) URL.revokeObjectURL(url);
                objectUrls.delete(key);
                return invalidateImagePreview(key);
            };
            let generation = skipActive ? currentPreviewGeneration(key) : releaseUrls();
            if (!skipActive) activeWrites.delete(key);
            if (!skipActive) imageWriteIntents.delete(key);
            await enqueuePreviewWork(async () => {
                if (!isCurrentPreview(key, generation) || (skipActive && (activeWrites.has(key) || collectImageStorageKeys(readRetainedMediaReferences()).has(key)))) return;
                if (skipActive) generation = releaseUrls();
                await previewStore.removeItem(key).catch(() => undefined);
                if (isCurrentPreview(key, generation)) await store.removeItem(key);
            });
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const revision = mutationRevision;
    const pendingKeys = new Set(activeWrites);
    if (await shouldDeferMediaCleanup()) return;
    const canRemove = (key: string) => !pendingKeys.has(key) && currentPreviewGeneration(key) <= revision;
    const usedKeys = collectImageStorageKeys([usedData, readRetainedMediaReferences()]);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key) && !activeWrites.has(key) && canRemove(key)) unused.push(key);
    });
    const unusedKeys = new Set(unused);
    const orphanPreviews: string[] = [];
    await previewStore.iterate((_value, key) => {
        if (!usedKeys.has(key) && !unusedKeys.has(key) && !activeWrites.has(key) && canRemove(key)) orphanPreviews.push(key);
    });
    collectImageStorageKeys(readRetainedMediaReferences(), usedKeys);
    const stillUnused = (key: string) => canRemove(key) && !usedKeys.has(key);
    await Promise.all([deleteStoredImages(unused.filter(stillUnused), true), ...orphanPreviews.filter(stillUnused).map((key) => deleteImagePreview(key, true))]);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string" && value.startsWith("image:")) keys.add(value);
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob, signal?: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        const cleanup = () => {
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
            signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
            cleanup();
            if (reader.readyState === FileReader.LOADING) reader.abort();
            reject(abortReason(signal));
        };
        reader.onload = () => { cleanup(); resolve(String(reader.result || "")); };
        reader.onerror = () => { cleanup(); reject(new Error(i18n.t("common.imageReadFailed"))); };
        reader.onabort = abort;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        reader.readAsDataURL(blob);
    });
}
