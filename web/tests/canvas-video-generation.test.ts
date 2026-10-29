import { expect, mock, spyOn, test } from "bun:test";
import type { UploadedFile } from "../src/services/file-storage";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const [videoApi, mediaStorage, { storeCanvasVideoResult }] = await (async () => {
    try {
        return await Promise.all([import("../src/services/api/video"), import("../src/services/file-storage"), import("../src/lib/canvas/canvas-video-generation")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();

const result = { blob: new Blob(["video"], { type: "video/mp4" }) };
const stored: UploadedFile = { url: "blob:new-video", storageKey: "video:new", bytes: 5, mimeType: "video/mp4" };
function publication() {
    let received: UploadedFile | undefined;
    return { publish: mock((video: UploadedFile) => { received = video; }), isPublished: (video: UploadedFile) => received === video };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

test("active canvas video storage returns its result without deleting media", async () => {
    const store = spyOn(videoApi, "storeGeneratedVideo").mockResolvedValue(stored);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const claim = spyOn(mediaStorage, "claimStoredMedia").mockImplementation(() => {});
    try {
        expect(await storeCanvasVideoResult(result, new AbortController().signal, () => true, publication())).toBe(stored);
        expect(store).toHaveBeenCalledWith(result);
        expect(remove).not.toHaveBeenCalled();
        expect(claim).toHaveBeenCalledWith(stored.storageKey);
    } finally { store.mockRestore(); remove.mockRestore(); claim.mockRestore(); }
});

test.each(["canceled", "superseded"])("a canvas result already %s does not begin storage", async (reason) => {
    const controller = new AbortController();
    if (reason === "canceled") controller.abort();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockResolvedValue(stored);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    try {
        await expect(storeCanvasVideoResult(result, controller.signal, () => reason !== "superseded", publication())).rejects.toMatchObject({ name: "AbortError" });
        expect(store).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test.each(["canceled", "superseded"])("a canvas result %s during storage cleans only its new unpublished key", async (reason) => {
    const controller = new AbortController();
    let current = controller;
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const apply = mock(() => undefined);
    try {
        const operation = storeCanvasVideoResult(result, controller.signal, () => current === controller, publication()).then(apply);
        expect(store).toHaveBeenCalledTimes(1);
        if (reason === "canceled") controller.abort();
        else current = new AbortController();
        pending.resolve(stored);
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        expect(apply).not.toHaveBeenCalled();
        expect(remove.mock.calls).toEqual([[["video:new"]]]);
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test("canceled URL-only fallback has no local key to remove", async () => {
    const controller = new AbortController();
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    try {
        const operation = storeCanvasVideoResult({ url: "https://video.example/result.mp4" }, controller.signal, () => true, publication());
        controller.abort();
        pending.resolve({ ...stored, url: "https://video.example/result.mp4", storageKey: "" });
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        expect(remove).not.toHaveBeenCalled();
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test("cleanup failure does not turn canvas cancellation into a generation error", async () => {
    const controller = new AbortController();
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockRejectedValue(new Error("cleanup failed"));
    try {
        const operation = storeCanvasVideoResult(result, controller.signal, () => true, publication());
        controller.abort();
        pending.resolve(stored);
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        expect(remove).toHaveBeenCalledWith([stored.storageKey]);
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test.each([false, true])("storage failure preserves canvas cancellation=%s without deleting an unknown key", async (cancel) => {
    const controller = new AbortController();
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const error = new Error("storage failed");
    try {
        const operation = storeCanvasVideoResult(result, controller.signal, () => true, publication());
        if (cancel) controller.abort();
        pending.reject(error);
        if (cancel) await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        else await expect(operation).rejects.toBe(error);
        expect(remove).not.toHaveBeenCalled();
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test("final publication completes in the storage continuation before a later cancellation microtask", async () => {
    const controller = new AbortController();
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const publish = publication();
    try {
        const operation = storeCanvasVideoResult(result, controller.signal, () => true, publish);
        pending.resolve(stored);
        queueMicrotask(() => controller.abort());
        expect(await operation).toBe(stored);
        expect(controller.signal.aborted).toBe(true);
        expect(publish.publish).toHaveBeenCalledTimes(1);
        expect(publish.isPublished(stored)).toBe(true);
        expect(remove).not.toHaveBeenCalled();
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test("cancellation queued before storage completion prevents publication in the same turn", async () => {
    const controller = new AbortController();
    const pending = deferred<UploadedFile>();
    const store = spyOn(videoApi, "storeGeneratedVideo").mockReturnValue(pending.promise);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const publish = publication();
    try {
        const operation = storeCanvasVideoResult(result, controller.signal, () => true, publish);
        queueMicrotask(() => controller.abort());
        pending.resolve(stored);
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        expect(publish.publish).not.toHaveBeenCalled();
        expect(remove.mock.calls).toEqual([[[stored.storageKey]]]);
    } finally { store.mockRestore(); remove.mockRestore(); }
});

test.each(["removed", "canceled", "superseded"])("a target %s during synchronous publication does not receive the fresh key", async (reason) => {
    const controller = new AbortController();
    let current = true;
    const store = spyOn(videoApi, "storeGeneratedVideo").mockResolvedValue(stored);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const claim = spyOn(mediaStorage, "claimStoredMedia").mockImplementation(() => {});
    const publish = { publish: mock(() => { if (reason === "canceled") controller.abort(); if (reason === "superseded") current = false; }), isPublished: () => false };
    try {
        await expect(storeCanvasVideoResult(result, controller.signal, () => current, publish)).rejects.toMatchObject({ name: "AbortError" });
        expect(publish.publish).toHaveBeenCalledTimes(1);
        expect(remove.mock.calls).toEqual([[[stored.storageKey]]]);
        expect(claim).not.toHaveBeenCalled();
    } finally { store.mockRestore(); remove.mockRestore(); claim.mockRestore(); }
});

test.each([false, true])("publication errors clean a fresh key only when node received it=%s", async (received) => {
    const error = new Error("renderer failed");
    let published = false;
    const store = spyOn(videoApi, "storeGeneratedVideo").mockResolvedValue(stored);
    const remove = spyOn(mediaStorage, "deleteStoredMedia").mockResolvedValue();
    const claim = spyOn(mediaStorage, "claimStoredMedia").mockImplementation(() => {});
    try {
        await expect(storeCanvasVideoResult(result, new AbortController().signal, () => true, {
            publish: () => { published = received; throw error; },
            isPublished: () => published,
        })).rejects.toBe(error);
        if (received) {
            expect(remove).not.toHaveBeenCalled();
            expect(claim).toHaveBeenCalledWith(stored.storageKey);
        } else {
            expect(remove.mock.calls).toEqual([[[stored.storageKey]]]);
            expect(claim).not.toHaveBeenCalled();
        }
    } finally { store.mockRestore(); remove.mockRestore(); claim.mockRestore(); }
});

