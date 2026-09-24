import localforage from "localforage";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { classifyNetworkFailure, isAbortError, isBrowserNetworkError, isOriginNotAllowedFetchResponse, networkFailureMessage } from "@/lib/network-errors";
import { withLocalProxy } from "@/stores/use-config-store";
import { readRetainedMediaReferences, shouldDeferMediaCleanup } from "@/services/media-references";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number; aspectRatio?: string };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const activeWrites = new Set<string>();
const generations = new Map<string, number>();
const mutationLocks = new Map<string, Promise<void>>();
let mutationRevision = 0;

export async function uploadMediaFile(input: string | Blob, prefix = "file", options?: { signal?: AbortSignal }): Promise<UploadedFile> {
    options?.signal?.throwIfAborted();
    let blob: Blob;
    if (typeof input === "string") {
        blob = await fetchMediaBlob(input, options?.signal);
    } else blob = input;
    options?.signal?.throwIfAborted();
    const storageKey = `${prefix}:${nanoid()}`;
    nextGeneration(storageKey);
    activeWrites.add(storageKey);
    try {
        await store.setItem(storageKey, blob);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        const meta = prefix === "video" || blob.type.startsWith("video/") ? await readVideoMeta(url) : prefix === "audio" || blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
        options?.signal?.throwIfAborted();
        return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    } catch (error) {
        const url = objectUrls.get(storageKey);
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        await store.removeItem(storageKey).catch(() => undefined);
        throw error;
    } finally {
        activeWrites.delete(storageKey);
    }
}

async function fetchMediaBlob(url: string, signal?: AbortSignal) {
    const requestUrl = withLocalProxy(url);
    let response: Response;
    try {
        response = await fetch(requestUrl, { signal });
    } catch (error) {
        if (isAbortError(error)) throw error;
        if (!isBrowserNetworkError(error)) throw error;
        const kind = classifyNetworkFailure(error, requestUrl);
        const wrapped = new Error(
            networkFailureMessage(error, requestUrl, {
                cors: i18n.t("apiErrors.corsRequired"),
                proxy: i18n.t("config.proxy.unreachable"),
                fallback: i18n.t("apiErrors.requestFailed"),
            }),
        ) as Error & { code?: string; cause?: unknown };
        // Keep a machine-readable marker so video generation can distinguish direct fallback from proxy failures.
        wrapped.code = kind === "proxy" ? "ERR_PROXY_UNREACHABLE" : "ERR_NETWORK";
        wrapped.cause = error;
        throw wrapped;
    }
    if (!response.ok) {
        if (await isOriginNotAllowedFetchResponse(response, requestUrl)) {
            const error = new Error(i18n.t("config.proxy.originNotAllowed")) as Error & { code?: string };
            error.code = "ERR_PROXY_ORIGIN_NOT_ALLOWED";
            throw error;
        }
        throw new Error(`Media download failed (${response.status})`);
    }
    return response.blob();
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const generation = currentGeneration(storageKey);
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob || currentGeneration(storageKey) !== generation) return fallback;
    const latest = objectUrls.get(storageKey);
    if (latest) return latest;
    const url = URL.createObjectURL(blob);
    if (currentGeneration(storageKey) !== generation) {
        URL.revokeObjectURL(url);
        return objectUrls.get(storageKey) || fallback;
    }
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    const generation = nextGeneration(storageKey);
    activeWrites.add(storageKey);
    try {
        return await withMutationLock(storageKey, async () => {
            if (currentGeneration(storageKey) !== generation) return objectUrls.get(storageKey) || "";
            await store.setItem(storageKey, blob);
            if (currentGeneration(storageKey) !== generation) return objectUrls.get(storageKey) || "";
            const previousUrl = objectUrls.get(storageKey);
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            const url = URL.createObjectURL(blob);
            objectUrls.set(storageKey, url);
            return url;
        });
    } finally {
        if (currentGeneration(storageKey) === generation) activeWrites.delete(storageKey);
    }
}

export async function deleteStoredMedia(keys: Iterable<string>, skipActive = false) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            if (skipActive && activeWrites.has(key)) return;
            const generation = skipActive ? currentGeneration(key) : nextGeneration(key);
            if (!skipActive) activeWrites.delete(key);
            await withMutationLock(key, async () => {
                if (currentGeneration(key) !== generation || (skipActive && (activeWrites.has(key) || collectMediaStorageKeys(readRetainedMediaReferences()).has(key)))) return;
                if (skipActive) nextGeneration(key);
                const url = objectUrls.get(key);
                if (url) URL.revokeObjectURL(url);
                objectUrls.delete(key);
                await store.removeItem(key);
            });
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const revision = mutationRevision;
    const pendingKeys = new Set(activeWrites);
    if (await shouldDeferMediaCleanup()) return;
    const canRemove = (key: string) => !pendingKeys.has(key) && currentGeneration(key) <= revision;
    const usedKeys = collectMediaStorageKeys([usedData, readRetainedMediaReferences()]);
    await videoLogStore.iterate((value) => {
        collectMediaStorageKeys(value, usedKeys);
    });
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key) && !activeWrites.has(key) && canRemove(key)) unused.push(key);
    });
    collectMediaStorageKeys(readRetainedMediaReferences(), usedKeys);
    await deleteStoredMedia(unused.filter((key) => canRemove(key) && !usedKeys.has(key)), true);
}

function currentGeneration(storageKey: string) {
    return generations.get(storageKey) || 0;
}

function nextGeneration(storageKey: string) {
    const generation = ++mutationRevision;
    generations.set(storageKey, generation);
    return generation;
}

async function withMutationLock<T>(storageKey: string, work: () => Promise<T>) {
    const previous = mutationLocks.get(storageKey) || Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    const tail = task.then(
        () => undefined,
        () => undefined,
    );
    mutationLocks.set(storageKey, tail);
    try {
        return await task;
    } finally {
        if (mutationLocks.get(storageKey) === tail) mutationLocks.delete(storageKey);
    }
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string" && /^(video|audio|file|video-reference|audio-reference):/.test(value)) keys.add(value);
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.onloadedmetadata = null;
            video.onerror = null;
            const meta = { width: video.videoWidth || undefined, height: video.videoHeight || undefined, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined };
            video.removeAttribute("src");
            resolve(meta);
        };
        const timer = window.setTimeout(done, 10_000);
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            audio.onloadedmetadata = null;
            audio.onerror = null;
            const durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined;
            audio.removeAttribute("src");
            resolve({ durationMs });
        };
        const timer = window.setTimeout(done, 10_000);
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.preload = "metadata";
        audio.src = url;
    });
}
