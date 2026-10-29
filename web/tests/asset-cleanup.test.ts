import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const [{ useAssetStore }, { useCanvasStore }, images, media, { localForageStorage }] = await (async () => {
    try {
        return await Promise.all([
            import("../src/stores/use-asset-store.ts?asset-cleanup-test") as Promise<typeof import("../src/stores/use-asset-store")>,
            import("../src/stores/canvas/use-canvas-store"),
            import("../src/services/image-storage"),
            import("../src/services/file-storage"),
            import("../src/lib/localforage-storage"),
        ]);
    } finally { if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage"); }
})();

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const emptyStorage = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
let assetsBefore = useAssetStore.getState();
let canvasBefore = useCanvasStore.getState();
let assetStorageBefore = useAssetStore.persist.getOptions().storage;
let canvasStorageBefore = useCanvasStore.persist.getOptions().storage;
let fallback: string | null = null;
let cleanImages: ReturnType<typeof spyOn<typeof images, "cleanupUnusedImages">>;
let cleanMedia: ReturnType<typeof spyOn<typeof media, "cleanupUnusedMedia">>;

beforeEach(() => {
    assetsBefore = useAssetStore.getState();
    canvasBefore = useCanvasStore.getState();
    assetStorageBefore = useAssetStore.persist.getOptions().storage;
    canvasStorageBefore = useCanvasStore.persist.getOptions().storage;
    useAssetStore.persist.setOptions({ storage: emptyStorage });
    useCanvasStore.persist.setOptions({ storage: emptyStorage });
    useAssetStore.setState({ hydrated: true, assets: [] });
    useCanvasStore.setState({ hydrated: true, projects: [] });
    fallback = null;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, localStorage: { getItem: () => fallback } } });
    cleanImages = spyOn(images, "cleanupUnusedImages").mockResolvedValue(undefined);
    cleanMedia = spyOn(media, "cleanupUnusedMedia").mockResolvedValue(undefined);
});

afterEach(() => {
    useAssetStore.setState(assetsBefore, true);
    useCanvasStore.setState(canvasBefore, true);
    useAssetStore.persist.setOptions({ storage: assetStorageBefore });
    useCanvasStore.persist.setOptions({ storage: canvasStorageBefore });
    cleanImages.mockRestore();
    cleanMedia.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test.each([[false, true], [true, false], [false, false]])("asset cleanup waits for hydrated roots (assets=%s, canvas=%s)", async (assets, canvas) => {
    useAssetStore.setState({ hydrated: assets });
    useCanvasStore.setState({ hydrated: canvas });
    await useAssetStore.getState().cleanupImages();
    expect(cleanImages).not.toHaveBeenCalled();
    expect(cleanMedia).not.toHaveBeenCalled();
});

test("asset cleanup forwards live asset, project and caller references to both storage sweeps", async () => {
    let extra = { storageKey: "video:first" };
    const roots: unknown[] = [];
    const initialProjects = useCanvasStore.getState().projects;
    cleanImages.mockImplementation(async input => {
        const read = input as () => unknown;
        roots.push(read());
        useAssetStore.getState().addAsset({ kind: "text", title: "published", tags: [], coverUrl: "", data: { content: "new owner" } });
        useCanvasStore.setState({ projects: [...initialProjects] });
        extra = { storageKey: "video:second" };
        roots.push(read());
    });
    cleanMedia.mockImplementation(async input => { roots.push((input as () => unknown)()); });
    await useAssetStore.getState().cleanupImages(() => extra);
    expect(roots).toHaveLength(3);
    expect(roots[0]).toEqual({ assets: [], projects: initialProjects, extra: { storageKey: "video:first" } });
    expect(roots[1]).toEqual({ assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects, extra });
    expect(roots[2]).toEqual(roots[1]);
    expect(useAssetStore.getState().assets).toHaveLength(1);
});

test("asset cleanup withdraws roots if hydration becomes unavailable during a sweep", async () => {
    cleanImages.mockImplementation(async input => {
        useCanvasStore.setState({ hydrated: false });
        expect((input as () => unknown)()).toBeNull();
    });
    cleanMedia.mockImplementation(async input => { expect((input as () => unknown)()).toBeNull(); });
    await useAssetStore.getState().cleanupImages();
});

test.each(["asset", "canvas"] as const)("failed %s rehydration keeps cleanup disabled", async kind => {
    const store = kind === "asset" ? useAssetStore : useCanvasStore;
    store.setState({ hydrated: false });
    store.persist.setOptions({ storage: { ...emptyStorage, getItem: async () => { throw new Error("persisted roots unavailable"); } } });
    await store.persist.rehydrate();
    expect(store.getState().hydrated).toBe(false);
    await useAssetStore.getState().cleanupImages();
    expect(cleanImages).not.toHaveBeenCalled();
    expect(cleanMedia).not.toHaveBeenCalled();
});

test.each(["asset", "canvas"] as const)("successful %s rehydration marks its roots ready", async kind => {
    const store = kind === "asset" ? useAssetStore : useCanvasStore;
    store.setState({ hydrated: false });
    await store.persist.rehydrate();
    expect(store.getState().hydrated).toBe(true);
});

test.each([null, ""])("failed IndexedDB reads with an empty fallback (%s) remain failures", async value => {
    fallback = value;
    const failure = new Error("IndexedDB unavailable");
    const read = spyOn(localforage, "getItem").mockRejectedValue(failure);
    try { await expect(localForageStorage.getItem("asset_store")).rejects.toBe(failure); }
    finally { read.mockRestore(); }
});

test("failed IndexedDB reads preserve an existing explicit fallback record", async () => {
    fallback = JSON.stringify({ state: { assets: [] }, version: 0 });
    const read = spyOn(localforage, "getItem").mockRejectedValue(new Error("IndexedDB unavailable"));
    try { expect(await localForageStorage.getItem("asset_store")).toBe(fallback); }
    finally { read.mockRestore(); }
});

test("a successful IndexedDB read can report a genuinely empty store", async () => {
    const read = spyOn(localforage, "getItem").mockResolvedValue(null);
    try { expect(await localForageStorage.getItem("asset_store")).toBeNull(); }
    finally { read.mockRestore(); }
});
