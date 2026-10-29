import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

const databases = new Map<string, Map<string, unknown>>();
const afterIterate = new Map<string, () => Promise<void>>();
const afterWrite = new Map<string, () => Promise<void>>();
const afterRemove = new Map<string, () => Promise<void>>();
const failedReads = new Set<string>();
const failedWrites = new Set<string>();
function database(name: string) {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name)!;
}
function memoryStore(name: string) {
    return {
        getItem: async (key: string) => database(name).get(key) ?? null,
        setItem: async (key: string, value: unknown) => {
            database(name).set(key, value);
            if (failedWrites.has(name)) throw new Error("storage write failed");
            await afterWrite.get(name)?.();
            return value;
        },
        removeItem: async (key: string) => { database(name).delete(key); await afterRemove.get(name)?.(); },
        iterate: async (visit: (value: unknown, key: string, index: number) => void) => {
            if (failedReads.has(name)) throw new Error("storage read failed");
            let index = 0;
            for (const [key, value] of database(name)) visit(value, key, ++index);
            await afterIterate.get(name)?.();
        },
    } as unknown as LocalForage;
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const createStore = spyOn(localforage, "createInstance").mockImplementation((options) => memoryStore(options?.storeName || "default"));
const [media, images, thumbnails] = await (async () => {
    try {
        return await Promise.all([
            import("../src/services/file-storage.ts?media-cleanup-test") as Promise<typeof import("../src/services/file-storage")>,
            import("../src/services/image-storage.ts?media-cleanup-test") as Promise<typeof import("../src/services/image-storage")>,
            import("../src/lib/image-thumbnail"),
        ]);
    } finally {
        createStore.mockRestore();
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();

const videoBlob = new Blob(["video"], { type: "video/mp4" });
const imageBlob = new Blob(["image"], { type: "image/png" });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
let metadata: (() => void) | undefined;
let metadataStarted: ReturnType<typeof deferred<void>>;
let pauseMetadata = false;
let failMetadata = false;
let revoke: ReturnType<typeof spyOn<typeof URL, "revokeObjectURL">>;
let preview: ReturnType<typeof spyOn<typeof thumbnails, "createImageThumbnail">>;

beforeEach(() => {
    databases.forEach((store) => store.clear());
    failedReads.clear();
    failedWrites.clear();
    afterIterate.clear();
    afterWrite.clear();
    afterRemove.clear();
    metadata = undefined;
    metadataStarted = deferred<void>();
    pauseMetadata = false;
    failMetadata = false;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => {
        if (failMetadata) throw new Error("metadata failed");
        return { videoWidth: 1280, videoHeight: 720, duration: 6, onloadedmetadata: () => {}, set src(_url: string) { metadata = () => this.onloadedmetadata(); metadataStarted.resolve(); if (!pauseMetadata) queueMicrotask(metadata); } };
    } } });
    Object.defineProperty(globalThis, "Image", { configurable: true, value: class {
        naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null;
        set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    } });
    revoke = spyOn(URL, "revokeObjectURL");
    // Decode and preview generation are outside these persistence ownership tests.
    preview = spyOn(thumbnails, "createImageThumbnail").mockResolvedValue(undefined);
});

afterEach(async () => {
    await media.deleteStoredMedia([...database("media_files").keys()]);
    await images.deleteStoredImages([...database("image_files").keys()]);
    revoke.mockRestore();
    preview.mockRestore();
    for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument], ["Image", originalImage]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test("media cleanup preserves video generation log ownership", async () => {
    database("media_files").set("video:logged", videoBlob);
    database("video_generation_logs").set("log", { video: { storageKey: "video:logged" } });
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob("video:logged")).toBe(videoBlob);
});

test("media cleanup preserves a stored upload while metadata is still pending", async () => {
    pauseMetadata = true;
    const upload = media.uploadMediaFile(videoBlob, "video");
    await metadataStarted.promise;
    const key = [...database("media_files").keys()][0];
    try {
        await media.cleanupUnusedMedia({});
        expect(await media.getMediaBlob(key)).toBe(videoBlob);
    } finally { metadata?.(); await upload; }
});

test("media cleanup preserves a returned upload until its owner is published", async () => {
    const stored = await media.uploadMediaFile(videoBlob, "video");
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(stored.storageKey)).toBe(videoBlob);
});

test.each(["media", "image"] as const)("%s cleanup rechecks references acquired during the file scan", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    const key = kind === "media" ? "video:existing" : "image:existing";
    const blob = kind === "media" ? videoBlob : imageBlob;
    database(name).set(key, blob);
    const scanned = deferred<void>();
    const resume = deferred<void>();
    let roots: unknown = {};
    afterIterate.set(name, async () => { scanned.resolve(); await resume.promise; });
    const cleanup = kind === "media" ? media.cleanupUnusedMedia(() => roots) : images.cleanupUnusedImages(() => roots);
    await scanned.promise;
    roots = { assets: [{ storageKey: key }] };
    resume.resolve();
    await cleanup;
    expect(database(name).get(key)).toBe(blob);
});

test("image cleanup preserves a returned image before reference publication", async () => {
    const stored = await images.uploadImage(imageBlob);
    await images.cleanupUnusedImages({});
    expect(await images.getImageBlob(stored.storageKey!)).toBe(imageBlob);
});

test("media cleanup refuses deletion when video log references cannot be read", async () => {
    database("media_files").set("video:existing", videoBlob);
    failedReads.add("video_generation_logs");
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob("video:existing")).toBe(videoBlob);
});

test("media uploads reject HTTP error documents before persistence", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    try {
        await expect(media.uploadMediaFile("https://media.example/missing.mp4", "video")).rejects.toThrow();
        expect(database("media_files").size).toBe(0);
    } finally { fetch.mockRestore(); }
});

test("failed media metadata creation removes the new file and object URL", async () => {
    failMetadata = true;
    await expect(media.uploadMediaFile(videoBlob, "video")).rejects.toThrow("metadata failed");
    expect(database("media_files").size).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(1);
});

test.each(["media", "image"] as const)("%s files become collectible after an observed owner releases them", async (kind) => {
    const stored = kind === "media" ? await media.uploadMediaFile(videoBlob, "video") : await images.uploadImage(imageBlob);
    const key = stored.storageKey!;
    const cleanup = kind === "media" ? media.cleanupUnusedMedia : images.cleanupUnusedImages;
    const name = kind === "media" ? "media_files" : "image_files";
    await cleanup({ assets: [{ storageKey: key }] });
    expect(database(name).has(key)).toBe(true);
    await cleanup({});
    expect(database(name).has(key)).toBe(false);
    expect(revoke).toHaveBeenCalledWith(stored.url);
    if (kind === "image") expect(database("image_previews").has(key)).toBe(false);
});

test("deleting a video log retains a shared asset until all owners release its key", async () => {
    const key = "video:shared";
    database("media_files").set(key, videoBlob);
    database("video_generation_logs").set("log", { video: { storageKey: key } });
    const roots = { assets: [{ data: { storageKey: key } }], projects: [] };
    await media.cleanupUnusedMedia(roots);
    database("video_generation_logs").delete("log");
    await media.cleanupUnusedMedia(roots);
    expect(await media.getMediaBlob(key)).toBe(videoBlob);
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(key)).toBeNull();
});

test("metadata in progress stays protected even if cleanup temporarily observes an owner", async () => {
    pauseMetadata = true;
    const upload = media.uploadMediaFile(videoBlob, "video");
    await metadataStarted.promise;
    const key = [...database("media_files").keys()][0];
    try {
        await media.cleanupUnusedMedia({ storageKey: key });
        await media.cleanupUnusedMedia({});
        expect(await media.getMediaBlob(key)).toBe(videoBlob);
    } finally { metadata?.(); await upload; }
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(key)).toBe(videoBlob);
    await media.cleanupUnusedMedia({ storageKey: key });
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(key)).toBeNull();
});

test.each(["media", "image"] as const)("overlapping %s writes keep protection until every write settles", async (kind) => {
    const key = kind === "media" ? "video:imported" : "image:imported";
    const name = kind === "media" ? "media_files" : "image_files";
    const write = kind === "media" ? media.setMediaBlob : images.setImageBlob;
    const cleanup = kind === "media" ? media.cleanupUnusedMedia : images.cleanupUnusedImages;
    const first = deferred<void>();
    const second = deferred<void>();
    let writes = 0;
    afterWrite.set(name, () => ++writes === 1 ? first.promise : second.promise);
    const firstWrite = write(key, kind === "media" ? videoBlob : imageBlob);
    const secondWrite = write(key, kind === "media" ? videoBlob : imageBlob);
    try {
        first.resolve();
        await firstWrite;
        await cleanup({ storageKey: key });
        await cleanup({});
        expect(database(name).has(key)).toBe(true);
    } finally { first.resolve(); second.resolve(); await Promise.all([firstWrite, secondWrite]); }
    await cleanup({});
    expect(database(name).has(key)).toBe(true);
    await cleanup({ storageKey: key });
    await cleanup({});
    expect(database(name).has(key)).toBe(false);
});

test.each([
    ["media", "media_files"], ["image", "image_files"],
    ["image", "image_generation_logs"], ["image", "video_generation_logs"], ["image", "image_previews"],
] as const)("%s cleanup is conservative when %s cannot be scanned", async (kind, failedStore) => {
    const name = kind === "media" ? "media_files" : "image_files";
    const key = kind === "media" ? "video:existing" : "image:existing";
    database(name).set(key, kind === "media" ? videoBlob : imageBlob);
    failedReads.add(failedStore);
    await (kind === "media" ? media.cleanupUnusedMedia({}) : images.cleanupUnusedImages({}));
    expect(database(name).has(key)).toBe(true);
});

test.each(["media", "image"] as const)("%s cleanup cancels deletion when reference roots become unavailable", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    const key = kind === "media" ? "video:existing" : "image:existing";
    database(name).set(key, kind === "media" ? videoBlob : imageBlob);
    let reads = 0;
    const roots = () => ++reads === 1 ? {} : null;
    await (kind === "media" ? media.cleanupUnusedMedia(roots) : images.cleanupUnusedImages(roots));
    expect(database(name).has(key)).toBe(true);
});

test.each(["media", "image"] as const)("%s cleanup reads live roots once per scan phase, not once per file", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    for (let index = 0; index < 100; index++) database(name).set(`${kind}:${index}`, kind === "media" ? videoBlob : imageBlob);
    let reads = 0;
    const roots = () => { reads++; return {}; };
    await (kind === "media" ? media.cleanupUnusedMedia(roots) : images.cleanupUnusedImages(roots));
    expect(reads).toBe(2);
    expect(database(name).size).toBe(0);
});

test.each(["media", "image"] as const)("a failed %s upload leaves no new stored file or cached URL", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    failedWrites.add(name);
    await expect(kind === "media" ? media.uploadMediaFile(videoBlob, "video") : images.uploadImage(imageBlob)).rejects.toThrow("storage write failed");
    expect(database(name).size).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(kind === "media" ? 0 : 1);
});

test.each(["media", "image"] as const)("a late %s cleanup cannot release the ownership of a newer write", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    const key = kind === "media" ? "video:existing" : "image:existing";
    const blob = kind === "media" ? videoBlob : imageBlob;
    database(name).set(key, blob);
    const cleanup = kind === "media" ? media.cleanupUnusedMedia : images.cleanupUnusedImages;
    const write = kind === "media" ? media.setMediaBlob : images.setImageBlob;
    const removed = deferred<void>();
    const resume = deferred<void>();
    afterRemove.set(name, async () => { removed.resolve(); await resume.promise; });
    const cleaning = cleanup({});
    await removed.promise;
    let url = "";
    try { url = await write(key, blob); }
    finally { afterRemove.delete(name); resume.resolve(); await cleaning; }
    await cleanup({});
    expect(database(name).get(key)).toBe(blob);
    expect(revoke.mock.calls.flat()).not.toContain(url);
});

test("a claimed video can be reclaimed immediately after its persisted log is removed", async () => {
    const stored = await media.uploadMediaFile(videoBlob, "video");
    database("video_generation_logs").set("log", { video: stored });
    media.claimStoredMedia(stored.storageKey);
    database("video_generation_logs").delete("log");
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(stored.storageKey)).toBeNull();
    expect(revoke).toHaveBeenCalledWith(stored.url);
});

test("claiming a persisted video retains it while a shared asset still owns the key", async () => {
    const stored = await media.uploadMediaFile(videoBlob, "video");
    database("video_generation_logs").set("log", { video: stored });
    media.claimStoredMedia(stored.storageKey);
    database("video_generation_logs").delete("log");
    await media.cleanupUnusedMedia({ assets: [{ data: stored }] });
    expect(await media.getMediaBlob(stored.storageKey)).toBe(videoBlob);
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(stored.storageKey)).toBeNull();
});

test("claiming an active upload cannot release its pending write protection", async () => {
    pauseMetadata = true;
    const upload = media.uploadMediaFile(videoBlob, "video");
    await metadataStarted.promise;
    const key = [...database("media_files").keys()][0];
    media.claimStoredMedia(key);
    try {
        await media.cleanupUnusedMedia({});
        expect(await media.getMediaBlob(key)).toBe(videoBlob);
    } finally { metadata?.(); await upload; }
    await media.cleanupUnusedMedia({});
    expect(await media.getMediaBlob(key)).toBe(videoBlob);
});

test("a video claimed after log scanning survives the in-flight cleanup", async () => {
    const stored = await media.uploadMediaFile(videoBlob, "video");
    const scanned = deferred<void>();
    const resume = deferred<void>();
    afterIterate.set("media_files", async () => { scanned.resolve(); await resume.promise; });
    const cleanup = media.cleanupUnusedMedia({});
    await scanned.promise;
    database("video_generation_logs").set("log", { video: stored });
    media.claimStoredMedia(stored.storageKey);
    resume.resolve();
    await cleanup;
    expect(await media.getMediaBlob(stored.storageKey)).toBe(videoBlob);
});

test.each(["media", "image"] as const)("overlapping %s cleanup cannot delete an owner observed by the other sweep", async (kind) => {
    const name = kind === "media" ? "media_files" : "image_files";
    const stored = kind === "media" ? await media.uploadMediaFile(videoBlob, "video") : await images.uploadImage(imageBlob);
    const cleanup = kind === "media" ? media.cleanupUnusedMedia : images.cleanupUnusedImages;
    const scanned = deferred<void>();
    const resume = deferred<void>();
    let scans = 0;
    afterIterate.set(name, async () => { if (++scans === 1) { scanned.resolve(); await resume.promise; } });
    const older = cleanup({});
    await scanned.promise;
    try { await cleanup({ storageKey: stored.storageKey }); }
    finally { resume.resolve(); await older; }
    expect(database(name).has(stored.storageKey!)).toBe(true);
});
