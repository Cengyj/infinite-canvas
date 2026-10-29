import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ReferenceImage } from "../src/types/image";
import type { UploadedImage } from "../src/services/image-storage";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const [{ createVideoReferenceImporter }, { defaultConfig, useConfigStore }, imageStorage] = await Promise.all([
    import("../src/pages/video/use-video-references"), import("../src/stores/use-config-store"), import("../src/services/image-storage"),
]);
if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");

const originalConfig = useConfigStore.getState().config;
const stored = (name: string): UploadedImage => ({ url: "blob:" + name, storageKey: "image:" + name, mimeType: "image/png", width: 1, height: 1, bytes: 1 });
const sources = (...names: string[]) => names.map((name) => ({ source: name, name }));
const references = (count: number): ReferenceImage[] => Array.from({ length: count }, (_, index) => ({ id: String(index), name: "existing-" + index, type: "image/png", dataUrl: "blob:existing-" + index }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

let refs: ReferenceImage[];
let imports: ReturnType<typeof createVideoReferenceImporter>;
let disconnect: () => void;
let upload: ReturnType<typeof spyOn<typeof imageStorage, "uploadImage">>;
let cleanup: ReturnType<typeof spyOn<typeof imageStorage, "deleteStoredImages">>;

beforeEach(() => {
    useConfigStore.setState({ config: { ...defaultConfig, model: "test::grok-imagine-video-1.5", videoModel: "test::grok-imagine-video-1.5", size: "16:9", channels: [{ id: "test", name: "Test", baseUrl: "https://example.test", apiKey: "test-only", apiFormat: "openai", models: [{ name: "grok-imagine-video-1.5", capability: "video" }, { name: "custom-video", capability: "video" }] }] } });
    refs = [];
    imports = createVideoReferenceImporter(() => refs, (images) => { refs = [...refs, ...images]; });
    disconnect = imports.connect();
    // Storage is mocked; these tests verify lifecycle and ownership, not image decoding.
    upload = spyOn(imageStorage, "uploadImage").mockImplementation(async (source) => stored(String(source)));
    cleanup = spyOn(imageStorage, "deleteStoredImages").mockResolvedValue(undefined);
});

afterEach(() => {
    disconnect();
    upload.mockRestore();
    cleanup.mockRestore();
    useConfigStore.setState({ config: originalConfig });
});

test("Grok keeps source and batch order even when later uploads finish first", async () => {
    const firstUpload = deferred<UploadedImage>();
    upload.mockImplementation(async (source) => source === "first" ? firstUpload.promise : stored(String(source)));
    const first = imports.import(sources("first", "second"));
    const second = imports.import(sources("third"));
    expect(imports.isImporting()).toBe(true);
    firstUpload.resolve(stored("first"));
    expect(await Promise.all([first, second])).toEqual([{ count: 2 }, { count: 1 }]);
    expect(refs.map((image) => image.name)).toEqual(["first", "second", "third"]);
    expect(imports.isImporting()).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
});

test.each(["empty", "failed"])("an early %s source does not break ordering for later Grok batches", async (kind) => {
    const firstUpload = deferred<UploadedImage>();
    upload.mockImplementation(async (source) => source === "first" ? firstUpload.promise : stored(String(source)));
    const first = imports.import(sources("first"));
    const middle = imports.import(async () => { if (kind === "failed") throw new Error("read failed"); return []; });
    if (kind === "failed") await expect(middle).rejects.toThrow("read failed");
    else expect(await middle).toEqual({ count: 0 });
    const last = imports.import(sources("last"));
    await Promise.resolve();
    await Promise.resolve();
    expect(refs).toEqual([]);
    firstUpload.resolve(stored("first"));
    await Promise.all([first, last]);
    expect(refs.map((image) => image.name)).toEqual(["first", "last"]);
});

test("Grok reserves pending image slots and rejects the entire excess batch before storage", async () => {
    refs = references(5);
    const ready = deferred<UploadedImage>();
    upload.mockImplementation(async () => ready.promise);
    const accepted = imports.import(sources("a", "b"));
    expect(await imports.import(sources("c", "d"))).toEqual({ count: 0, warning: "importLimit", values: { max: 7, count: 7, added: 2 } });
    expect(upload).toHaveBeenCalledTimes(2);
    ready.resolve(stored("reserved"));
    expect(await accepted).toEqual({ count: 2 });
    expect(refs).toHaveLength(7);
});

test("a clipboard read belongs to its original session before the source is available", async () => {
    const clipboard = deferred<ReturnType<typeof sources>>();
    const pending = imports.import(() => clipboard.promise);
    expect(imports.isImporting()).toBe(true);
    imports.reset();
    expect(imports.isImporting()).toBe(false);
    clipboard.resolve(sources("stale"));
    expect(await pending).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(refs).toEqual([]);
});

test("reset releases uploaded batches waiting behind an unresolved clipboard permission", async () => {
    const clipboard = deferred<ReturnType<typeof sources>>();
    const first = imports.import(() => clipboard.promise);
    const second = imports.import(sources("uploaded"));
    await Promise.resolve();
    await Promise.resolve();
    imports.reset();
    expect(await second).toBeNull();
    expect([...cleanup.mock.calls[0][0]]).toEqual(["image:uploaded"]);
    expect(refs).toEqual([]);
    clipboard.resolve(sources("late"));
    expect(await first).toBeNull();
    expect(upload).toHaveBeenCalledTimes(1);
});

test("reset aborts old uploads, removes only unclaimed keys, and accepts a fresh session", async () => {
    const oldUpload = deferred<UploadedImage>();
    upload.mockImplementation(async (source) => source === "old" ? oldUpload.promise : stored(String(source)));
    const pending = imports.import(sources("old"));
    const signal = upload.mock.calls[0][1]?.signal;
    imports.reset();
    expect(signal?.aborted).toBe(true);
    expect(await imports.import(sources("new"))).toEqual({ count: 1 });
    oldUpload.resolve(stored("old"));
    expect(await pending).toBeNull();
    expect(refs.map((image) => image.name)).toEqual(["new"]);
    expect([...cleanup.mock.calls[0][0]]).toEqual(["image:old"]);
});

test("switching away from Grok and back invalidates an upload even if the final model matches", async () => {
    const ready = deferred<UploadedImage>();
    upload.mockImplementation(async () => ready.promise);
    const pending = imports.import(sources("stale"));
    const config = useConfigStore.getState().config;
    useConfigStore.setState({ config: { ...config, videoModel: "test::custom-video" } });
    useConfigStore.setState({ config });
    ready.resolve(stored("stale"));
    expect(await pending).toBeNull();
    expect(refs).toEqual([]);
    expect(imports.isImporting()).toBe(false);
});

test("adding a saved script invalidates an in-flight built-in Grok upload", async () => {
    const ready = deferred<UploadedImage>();
    upload.mockImplementation(async () => ready.promise);
    const pending = imports.import(sources("stale"));
    const config = useConfigStore.getState().config;
    useConfigStore.setState({ config: { ...config, channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, script: "return 'custom';" })) })) } });
    ready.resolve(stored("stale"));
    expect(await pending).toBeNull();
    expect(refs).toEqual([]);
});

test("legacy mode and resolution changes preserve imports and never downgrade configuration", async () => {
    refs = references(1);
    const ready = deferred<UploadedImage>();
    upload.mockImplementation(async () => ready.promise);
    const pending = imports.import(sources("second"));
    const config = { ...useConfigStore.getState().config, videoMode: "frames", vquality: "1080", size: "1920x1080" };
    useConfigStore.setState({ config });
    ready.resolve(stored("second"));
    expect(await pending).toEqual({ count: 1 });
    expect(refs).toHaveLength(2);
    expect(useConfigStore.getState().config).toEqual(config);
});

test("failed batches clean successful partial uploads and release the following commit", async () => {
    upload.mockImplementation(async (source) => { if (source === "bad") throw new Error("upload failed"); return stored(String(source)); });
    const failed = imports.import(sources("unused", "bad"));
    const next = imports.import(sources("kept"));
    await expect(failed).rejects.toThrow("upload failed");
    expect(await next).toEqual({ count: 1 });
    expect(refs.map((image) => image.name)).toEqual(["kept"]);
    expect([...cleanup.mock.calls[0][0]]).toEqual(["image:unused"]);
    expect(imports.isImporting()).toBe(false);
});

test("cleanup completing after reset cannot deliver an obsolete failure", async () => {
    const cleaning = deferred<void>();
    const cleaned = deferred<void>();
    cleanup.mockImplementation(async () => { cleaning.resolve(); await cleaned.promise; });
    upload.mockImplementation(async (source) => { if (source === "bad") throw new Error("obsolete"); return stored(String(source)); });
    const pending = imports.import(sources("unused", "bad"));
    await cleaning.promise;
    imports.reset();
    cleaned.resolve();
    expect(await pending).toBeNull();
});

test("disconnect and reconnect keep old imports out of the remounted session", async () => {
    const ready = deferred<UploadedImage>();
    upload.mockImplementation(async () => ready.promise);
    const pending = imports.import(sources("old"));
    disconnect();
    expect(await imports.import(sources("unmounted"))).toBeNull();
    disconnect = imports.connect();
    ready.resolve(stored("old"));
    expect(await pending).toBeNull();
    expect(refs).toEqual([]);
});

test.each(["custom", "script"])("%s route keeps ordinary capacity slicing and a successful zero at full capacity", async (kind) => {
    const config = useConfigStore.getState().config;
    useConfigStore.setState({ config: kind === "custom" ? { ...config, videoModel: "test::custom-video" } : { ...config, channels: config.channels.map((channel) => ({ ...channel, models: channel.models.map((model) => ({ ...model, script: "return 'custom';" })) })) } });
    refs = references(6);
    expect(await imports.import(sources("one", "two", "three"))).toEqual({ count: 1 });
    expect(refs.map((image) => image.name).at(-1)).toBe("one");
    expect(await imports.import(sources("full"))).toEqual({ count: 0 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(refs).toHaveLength(7);
});
