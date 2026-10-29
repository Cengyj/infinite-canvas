import { beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

const records = new Map<string, unknown>();
const calls: string[] = [];
let readError: Error | null = null;
let writeError: Error | null = null;
let removeError: Error | null = null;
let beforeIterate: (() => Promise<void>) | null = null;
let beforeWrite: (() => Promise<void>) | null = null;
let afterFirstEntry: (() => void) | null = null;
const keyFor = (scenario: string, text: string) => JSON.stringify([scenario, text]);
const put = (scenario: string, text: string) => records.set(keyFor(scenario, text), { scenario, text });
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

const disk = {
    iterate: async (visitor: (value: unknown, key: string) => void) => {
        calls.push("iterate");
        const snapshot = structuredClone([...records]);
        await beforeIterate?.();
        if (readError) throw readError;
        for (const [index, [key, value]] of snapshot.entries()) {
            visitor(value, key);
            if (index === 0) afterFirstEntry?.();
        }
    },
    getItem: async (key: string) => {
        calls.push("get");
        if (readError) throw readError;
        return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    setItem: async (key: string, value: unknown) => {
        calls.push("set");
        await beforeWrite?.();
        if (writeError) throw writeError;
        records.set(key, structuredClone(value));
        return value;
    },
    removeItem: async (key: string) => {
        calls.push("remove");
        if (removeError) throw removeError;
        records.delete(key);
    },
};

const createInstance = spyOn(localforage, "createInstance").mockReturnValue(disk as unknown as LocalForage);
const { usePromptOptimizationStore: store } = await (async () => {
    try {
        return await import("../src/stores/use-prompt-optimization-store.ts?requirements-tests") as typeof import("../src/stores/use-prompt-optimization-store");
    } finally { createInstance.mockRestore(); }
})();
const actions = store.getState();

beforeEach(() => {
    records.clear();
    calls.length = 0;
    readError = writeError = removeError = null;
    beforeIterate = beforeWrite = null;
    afterFirstEntry = null;
    store.setState({ items: { image: [], video: [] }, loaded: false, loading: false, error: null });
});

test("loading is read-only and distinguishes genuinely empty storage from an error", async () => {
    expect(calls).toEqual([]);
    expect(store.getState().loaded).toBe(false);
    await actions.load();
    expect(store.getState()).toMatchObject({ items: { image: [], video: [] }, loaded: true, loading: false, error: null });
    expect(calls).toEqual(["iterate"]);
});

test("requirements stay isolated by scenario and preserve internal whitespace", async () => {
    const text = '保留中文“包装文字”\n  第二行：250 g';
    await actions.save("image", `  ${text}  `);
    await actions.save("image", text);
    await actions.save("video", text);
    expect(store.getState().items).toEqual({ image: [text], video: [text] });
    expect([...records.values()]).toEqual([{ scenario: "image", text }, { scenario: "video", text }]);
    expect(calls.filter((call) => call === "set")).toHaveLength(2);
    await actions.load();
    expect(store.getState().items).toEqual({ image: [text], video: [text] });
});

test("standard composite keys preserve arbitrary punctuation without collisions", async () => {
    const texts = ['image:video', 'a\n["video","b"]', '保留 😀 / % \u0000'];
    for (const text of texts) await actions.save("image", text);
    expect(records.size).toBe(texts.length);
    for (const [key, value] of records) expect(JSON.parse(key)).toEqual(["image", (value as { text: string }).text]);
    await actions.load();
    expect(store.getState().items.image).toEqual([...texts].sort());
});

test("blank inputs reject before any storage operation", async () => {
    await expect(actions.save("image", "  \n ")).rejects.toThrow("请先填写");
    await expect(actions.remove("video", "")).rejects.toThrow("请先填写");
    expect(calls).toEqual([]);
    expect(records.size).toBe(0);
});

test("a partial failed refresh retains the last successful list and rejects subsequent writes while unreadable", async () => {
    put("image", "known");
    await actions.load();
    put("video", "external");
    const failure = new Error("cursor failed");
    afterFirstEntry = () => { throw failure; };
    await expect(actions.load()).rejects.toBe(failure);
    expect(store.getState()).toMatchObject({ items: { image: ["known"], video: [] }, loaded: false, loading: false, error: failure.message });
    await expect(actions.save("image", "new")).rejects.toBe(failure);
    expect(records.size).toBe(2);
    expect(calls).not.toContain("set");
    afterFirstEntry = null;
    await actions.load();
    expect(store.getState()).toMatchObject({ items: { image: ["known"], video: ["external"] }, loaded: true, error: null });
});

test.each([
    ["invalid-key", { scenario: "image", text: "saved" }],
    [keyFor("image", "saved"), { scenario: "video", text: "saved" }],
    [keyFor("image", "saved"), { scenario: "image", text: "different" }],
    [keyFor("image", " saved "), { scenario: "image", text: " saved " }],
    [keyFor("image", ""), { scenario: "image", text: "" }],
    [keyFor("image", "saved"), null],
    [keyFor("audio", "saved"), { scenario: "audio", text: "saved" }],
])("malformed entry %s rejects hydration without clearing or replacing records", async (key, value) => {
    records.set(key as string, value);
    const original = structuredClone([...records]);
    await expect(actions.load()).rejects.toThrow("数据损坏");
    await expect(actions.save("image", "saved")).rejects.toThrow("数据损坏");
    expect([...records]).toEqual(original);
    expect(store.getState()).toMatchObject({ loaded: false, loading: false });
    expect(calls).not.toContain("set");
    expect(calls).not.toContain("remove");
});

test("failed saves reject without publishing unsaved favorites and do not poison later operations", async () => {
    put("image", "existing");
    await actions.load();
    writeError = new Error("quota exceeded");
    await expect(actions.save("image", "new")).rejects.toBe(writeError);
    expect(store.getState().items.image).toEqual(["existing"]);
    expect(records.has(keyFor("image", "new"))).toBe(false);
    writeError = null;
    await actions.save("image", "new");
    expect(store.getState()).toMatchObject({ items: { image: ["existing", "new"], video: [] }, error: null });
});

test("failed deletes preserve the stored and visible favorite", async () => {
    await actions.save("video", "keep subject");
    removeError = new Error("delete failed");
    await expect(actions.remove("video", "keep subject")).rejects.toBe(removeError);
    expect(store.getState().items.video).toEqual(["keep subject"]);
    expect(records.has(keyFor("video", "keep subject"))).toBe(true);
    removeError = null;
    await actions.remove("video", " keep subject ");
    expect(store.getState().items.video).toEqual([]);
    expect(records.size).toBe(0);
});

test("a failed per-entry read cannot be treated as a missing favorite", async () => {
    await actions.save("image", "keep");
    const writeCount = calls.filter((call) => call === "set").length;
    readError = new Error("database unavailable");
    await expect(actions.save("image", "keep")).rejects.toBe(readError);
    expect(store.getState()).toMatchObject({ items: { image: ["keep"], video: [] }, loaded: false });
    expect(calls.filter((call) => call === "set")).toHaveLength(writeCount);
});

test.each(["save", "remove"] as const)("%s preserves an entry corrupted after the initial load", async (operation) => {
    await actions.save("image", "keep");
    const corrupted = { scenario: "video", text: "another" };
    records.set(keyFor("image", "keep"), corrupted);
    await expect(actions[operation]("image", "keep")).rejects.toThrow("数据损坏");
    expect(records.get(keyFor("image", "keep"))).toEqual(corrupted);
    expect(store.getState().items.image).toEqual(["keep"]);
});

test("initial loading and concurrent saves are serialized without a late snapshot overwriting new items", async () => {
    put("image", "existing");
    const started = deferred();
    const release = deferred();
    beforeIterate = async () => { started.resolve(); await release.promise; };
    const loading = actions.load();
    await started.promise;
    const first = actions.save("image", "one");
    const second = actions.save("image", "two");
    expect(store.getState().loading).toBe(true);
    expect(calls).toEqual(["iterate"]);
    release.resolve();
    await Promise.all([loading, first, second]);
    expect(store.getState().items.image).toEqual(["existing", "one", "two"]);
    expect(records.size).toBe(3);
});

test("concurrent save/remove/save calls preserve invocation order and publish only committed data", async () => {
    const started = deferred();
    const release = deferred();
    beforeWrite = async () => { started.resolve(); await release.promise; };
    const first = actions.save("image", "same");
    await started.promise;
    expect(store.getState().items.image).toEqual([]);
    const removal = actions.remove("image", "same");
    const last = actions.save("image", "same");
    release.resolve();
    await Promise.all([first, removal, last]);
    expect(calls.filter((call) => call === "set" || call === "remove")).toEqual(["set", "remove", "set"]);
    expect(store.getState().items.image).toEqual(["same"]);
    expect(records.get(keyFor("image", "same"))).toEqual({ scenario: "image", text: "same" });
});

test("concurrent duplicate saves produce one stored entry", async () => {
    await Promise.all([actions.save("video", "same"), actions.save("video", " same ")]);
    expect(records.size).toBe(1);
    expect(calls.filter((call) => call === "set")).toHaveLength(1);
    expect(store.getState().items.video).toEqual(["same"]);
});

test("a queued refresh reads committed writes rather than reintroducing deleted entries", async () => {
    await actions.save("image", "remove me");
    await Promise.all([actions.remove("image", "remove me"), actions.load()]);
    expect(store.getState().items.image).toEqual([]);
    expect(records.size).toBe(0);
});

test("per-entry mutations preserve other-tab additions until an explicit refresh observes them", async () => {
    await actions.save("image", "local");
    put("video", "external");
    await actions.save("image", "new local");
    await actions.remove("image", "local");
    expect(records.get(keyFor("video", "external"))).toEqual({ scenario: "video", text: "external" });
    expect(store.getState().items.video).toEqual([]);
    await actions.load();
    expect(store.getState().items).toEqual({ image: ["new local"], video: ["external"] });
});

test("deleting one scenario never removes the same text from another scenario", async () => {
    await actions.save("image", "same");
    await actions.save("video", "same");
    await actions.remove("image", "same");
    expect(store.getState().items).toEqual({ image: [], video: ["same"] });
    expect(records.size).toBe(1);
});

test("saving and refreshing never truncates long requirements or prunes older favorites", async () => {
    const text = "保留正文".repeat(600);
    const requirements = Array.from({ length: 35 }, (_, index) => `${index}: ${text}`);
    await Promise.all(requirements.map((requirement) => actions.save("image", requirement)));
    await actions.load();
    expect(store.getState().items.image).toEqual([...requirements].sort());
    expect(records.size).toBe(requirements.length);
});
