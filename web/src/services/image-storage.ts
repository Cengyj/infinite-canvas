import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export type ImageStorageLease = {
    add: (key: string) => void;
    release: () => void;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const activeImageKeysByOwner = new Map<string, Set<string>>();
const leasedImageKeySets = new Set<Set<string>>();
const imageStorageTabChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("infinite-canvas:image-storage-tabs");
const imageStorageTabProbes = new Map<string, () => void>();
let cleanupQueue = Promise.resolve();

imageStorageTabChannel?.addEventListener("message", (event: MessageEvent<{ type?: string; id?: string }>) => {
    const { type, id } = event.data || {};
    if (!id) return;
    if (type === "probe") imageStorageTabChannel.postMessage({ type: "present", id });
    else if (type === "present") imageStorageTabProbes.get(id)?.();
});

export async function uploadImage(input: string | Blob, lease?: ImageStorageLease): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await fetchImageBlob(input) : input;
    if (!blob.size || (blob.type && !blob.type.startsWith("image/"))) throw new Error(i18n.t("common.imageReadFailed"));
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        const meta = await readStoredImageMeta(url);
        lease?.add(storageKey);
        await store.setItem(storageKey, blob);
        objectUrls.set(storageKey, url);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || "image/png" };
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

async function fetchImageBlob(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("common.imageReadFailed"));
    const blob = await response.blob();
    if (blob.type && !blob.type.startsWith("image/")) throw new Error(i18n.t("common.imageReadFailed"));
    return blob;
}

function readStoredImageMeta(url: string) {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const cleanup = () => {
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const fail = () => settle(() => {
            image.src = "";
            reject(new Error(i18n.t("common.imageReadFailed")));
        });
        const timer = window.setTimeout(fail, 10000);
        image.onload = () => {
            const width = image.naturalWidth;
            const height = image.naturalHeight;
            if (!width || !height) {
                fail();
                return;
            }
            settle(() => resolve({ width, height }));
        };
        image.onerror = fail;
        image.src = url;
    });
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
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

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    if (!blob.size || (blob.type && !blob.type.startsWith("image/"))) throw new Error(i18n.t("common.imageReadFailed"));
    const url = URL.createObjectURL(blob);
    try {
        await readStoredImageMeta(url);
        await store.setItem(storageKey, blob);
        const previousUrl = objectUrls.get(storageKey);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        objectUrls.set(storageKey, url);
        return url;
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, signal?: AbortSignal) {
    throwIfAborted(signal);
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    throwIfAborted(signal);
    if (!url || url.startsWith("data:")) return url;
    try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(i18n.t("common.imageReadFailed"));
        const blob = await response.blob();
        if (blob.type && !blob.type.startsWith("image/")) throw new Error(i18n.t("common.imageReadFailed"));
        return await blobToDataUrl(blob, signal);
    } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
    }
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export function registerActiveImageStorageKeys(owner: string, keys: Iterable<string>) {
    const registration = new Set(Array.from(keys).filter((key) => key.startsWith("image:")));
    activeImageKeysByOwner.set(owner, registration);
    return () => {
        if (activeImageKeysByOwner.get(owner) === registration) activeImageKeysByOwner.delete(owner);
    };
}

export function createImageStorageLease(keys: Iterable<string> = []): ImageStorageLease {
    const registration = new Set(Array.from(keys).filter((key) => key.startsWith("image:")));
    leasedImageKeySets.add(registration);
    let released = false;
    return {
        add: (key) => {
            if (!released && key.startsWith("image:")) registration.add(key);
        },
        release: () => {
            if (released) return;
            released = true;
            void cleanupQueue.then(() => leasedImageKeySets.delete(registration));
        },
    };
}

export function cleanupUnusedImages(usedData: unknown | (() => unknown)) {
    const cleanup = cleanupQueue.then(() => removeUnusedImages(usedData));
    cleanupQueue = cleanup.then(() => undefined, () => undefined);
    return cleanup;
}

async function removeUnusedImages(usedData: unknown | (() => unknown)) {
    if (await hasAnotherImageStorageTab()) return false;
    const readUsedData = () => (typeof usedData === "function" ? usedData() : usedData);
    const usedKeys = collectImageStorageKeys(readUsedData());
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    activeImageKeysByOwner.forEach((keys) => keys.forEach((key) => usedKeys.add(key)));
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key) && !isActiveImageStorageKey(key)) unused.push(key);
    });
    collectImageStorageKeys(readUsedData(), usedKeys);
    if (await hasAnotherImageStorageTab()) return false;
    await deleteStoredImages(unused.filter((key) => !usedKeys.has(key) && !isActiveImageStorageKey(key)));
    return true;
}

function hasAnotherImageStorageTab() {
    if (!imageStorageTabChannel) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        const id = nanoid();
        const timer = window.setTimeout(() => {
            imageStorageTabProbes.delete(id);
            resolve(false);
        }, 200);
        imageStorageTabProbes.set(id, () => {
            window.clearTimeout(timer);
            imageStorageTabProbes.delete(id);
            resolve(true);
        });
        try {
            imageStorageTabChannel.postMessage({ type: "probe", id });
        } catch {
            window.clearTimeout(timer);
            imageStorageTabProbes.delete(id);
            resolve(true);
        }
    });
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("image:")) keys.add(value);
        return keys;
    }
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function isActiveImageStorageKey(key: string) {
    for (const keys of activeImageKeysByOwner.values()) if (keys.has(key)) return true;
    for (const keys of leasedImageKeySets) if (keys.has(key)) return true;
    return false;
}

function blobToDataUrl(blob: Blob, signal?: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        let settled = false;
        const cleanup = () => {
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
            signal?.removeEventListener("abort", onSignalAbort);
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const rejectAbort = () => settle(() => reject(abortError()));
        const onSignalAbort = () => {
            if (reader.readyState === FileReader.LOADING) reader.abort();
            rejectAbort();
        };
        reader.onload = () => settle(() => resolve(String(reader.result || "")));
        reader.onerror = () => settle(() => reject(new Error(i18n.t("common.imageReadFailed"))));
        reader.onabort = rejectAbort;
        signal?.addEventListener("abort", onSignalAbort, { once: true });
        if (signal?.aborted) {
            onSignalAbort();
            return;
        }
        reader.readAsDataURL(blob);
    });
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
}

function abortError() {
    return new DOMException("Aborted", "AbortError");
}
