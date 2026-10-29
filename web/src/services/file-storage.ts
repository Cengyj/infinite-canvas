import localforage from "localforage";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { withLocalProxy } from "@/stores/use-config-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
// Keep new files until an authoritative reference is observed; the count covers active writes.
const unclaimedKeys = new Map<string, number>();
let ownershipRevision = 0;

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    let blob: Blob;
    if (typeof input === "string") {
        const response = await fetch(withLocalProxy(input));
        if (!response.ok) throw new Error(i18n.t("apiErrors.httpFailed", { status: response.status }));
        blob = await response.blob();
    } else blob = input;
    const storageKey = `${prefix}:${nanoid()}`;
    unclaimedKeys.set(storageKey, 1);
    let url = "";
    try {
        await store.setItem(storageKey, blob);
        url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
        return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        objectUrls.delete(storageKey);
        unclaimedKeys.delete(storageKey);
        await store.removeItem(storageKey).catch(() => undefined);
        throw error;
    } finally {
        if (unclaimedKeys.has(storageKey)) unclaimedKeys.set(storageKey, unclaimedKeys.get(storageKey)! - 1);
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    unclaimedKeys.set(storageKey, (unclaimedKeys.get(storageKey) || 0) + 1);
    try {
        await store.setItem(storageKey, blob);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    } finally {
        if (unclaimedKeys.has(storageKey)) unclaimedKeys.set(storageKey, unclaimedKeys.get(storageKey)! - 1);
    }
}

// Call only after an authoritative owner has successfully published the file.
export function claimStoredMedia(storageKey: string) {
    if (unclaimedKeys.get(storageKey) === 0) {
        unclaimedKeys.delete(storageKey);
        ownershipRevision++;
    }
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            const claim = unclaimedKeys.get(key);
            await store.removeItem(key);
            if (objectUrls.get(key) !== url || unclaimedKeys.get(key) !== claim) {
                if (url && objectUrls.get(key) !== url) URL.revokeObjectURL(url);
                return;
            }
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            unclaimedKeys.delete(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const revision = ownershipRevision;
    const readUsedData = () => typeof usedData === "function" ? usedData() : usedData;
    const usedKeys = new Set<string>();
    const keys: string[] = [];
    try {
        const initial = readUsedData();
        if (initial == null) return;
        collectMediaStorageKeys(initial, usedKeys);
        await videoLogStore.iterate((value) => { collectMediaStorageKeys(value, usedKeys); });
        await store.iterate((_value, key) => { keys.push(key); });
        const current = readUsedData();
        if (current == null) return;
        collectMediaStorageKeys(current, usedKeys);
    } catch { return; }
    if (ownershipRevision !== revision) return;
    for (const key of usedKeys) claimStoredMedia(key);
    await deleteStoredMedia(keys.filter((key) => !usedKeys.has(key) && !unclaimedKeys.has(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
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
