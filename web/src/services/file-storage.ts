import localforage from "localforage";
import { nanoid } from "nanoid";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number; aspectRatio?: string };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = prefix === "video" || blob.type.startsWith("video/") ? await readVideoMeta(url) : prefix === "audio" || blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    const resolved = objectUrls.get(storageKey);
    if (resolved) return resolved;
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    const previousUrl = objectUrls.get(storageKey);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown | (() => unknown)) {
    const readUsedData = () => (typeof usedData === "function" ? usedData() : usedData);
    const usedKeys = collectMediaStorageKeys(readUsedData());
    await videoLogStore.iterate((value) => {
        collectMediaStorageKeys(value, usedKeys);
    });
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    collectMediaStorageKeys(readUsedData(), usedKeys);
    await deleteStoredMedia(unused.filter((key) => !usedKeys.has(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("video:") || value.startsWith("audio:") || value.startsWith("file:")) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width?: number; height?: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => {
            const meta = { width: video.videoWidth || undefined, height: video.videoHeight || undefined, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined };
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute("src");
            resolve(meta);
        };
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
