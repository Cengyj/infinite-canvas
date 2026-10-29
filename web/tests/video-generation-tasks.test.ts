import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";
import type { UploadedFile } from "../src/services/file-storage";
import type { VideoGenerationTask, VideoGenerationTaskState } from "../src/services/api/video";
import type { GenerationLog } from "../src/pages/video/video-generation-tasks";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const [{ createVideoGenerationTasks }, api, media, { defaultConfig }, { useWorkbenchAgentStore }] = await Promise.all([
    import("../src/pages/video/video-generation-tasks"), import("../src/services/api/video"), import("../src/services/file-storage"), import("../src/stores/use-config-store"), import("../src/stores/use-workbench-agent-store"),
]);
if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");

const task: VideoGenerationTask = { id: "remote-a", provider: "openai", model: "channel::grok-imagine-video-1.5" };
const complete: VideoGenerationTaskState = { status: "completed", result: { url: "https://example.test/result.mp4" } };
const stored: UploadedFile = { url: "blob:generated", storageKey: "video:generated", width: 640, height: 480, bytes: 10, mimeType: "video/mp4" };
const config: AiConfig = { ...defaultConfig, model: task.model, videoModel: task.model, videoSeconds: "6", vquality: "720", size: "16:9" };
const log = (id = "a", pendingTask?: VideoGenerationTask): GenerationLog => ({ id, createdAt: Date.now(), title: id, prompt: "prompt-" + id, time: "time", model: task.model, config, references: [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }], durationMs: 0, size: "16:9", resolution: "720", seconds: "6", status: "pending", task: pendingTask });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }

const disconnects: Array<() => void> = [];
function harness(initial: GenerationLog[] = []) {
    const rows = new Map(initial.map((item) => [item.id, item]));
    const events: string[] = [];
    const storage = {
        read: mock(async () => [...rows.values()]),
        write: mock(async (item: GenerationLog) => { events.push("write:" + item.status); rows.set(item.id, structuredClone(item)); }),
        remove: mock(async (id: string) => { events.push("remove:" + id); rows.delete(id); }),
        cleanup: mock(async (_retainedMedia: () => unknown) => { events.push("cleanup"); }),
    };
    const manager = createVideoGenerationTasks(storage);
    const mount = () => {
        const callbacks = { getReferences: mock(() => [] as GenerationLog["references"]), configFor: mock((item: GenerationLog) => ({ ...config, ...item.config })), onLogs: mock((_items: GenerationLog[]) => {}), onRunning: mock((_value: boolean) => {}), onResult: mock((_item: GenerationLog) => {}), onSuccess: mock(() => {}), onError: mock((_message: string) => {}) };
        const view = manager.createView(callbacks);
        const disconnect = view.connect();
        disconnects.push(disconnect);
        return { view, callbacks, disconnect };
    };
    return { rows, events, storage, manager, mount };
}

let create: ReturnType<typeof spyOn<typeof api, "createVideoGenerationTask">>;
let poll: ReturnType<typeof spyOn<typeof api, "pollVideoGenerationTask">>;
let store: ReturnType<typeof spyOn<typeof api, "storeGeneratedVideo">>;
let discard: ReturnType<typeof spyOn<typeof media, "deleteStoredMedia">>;
let claim: ReturnType<typeof spyOn<typeof media, "claimStoredMedia">>;
const oldAgentTasks = useWorkbenchAgentStore.getState().tasks;
beforeEach(() => {
    create = spyOn(api, "createVideoGenerationTask").mockResolvedValue(task);
    poll = spyOn(api, "pollVideoGenerationTask").mockResolvedValue(complete);
    store = spyOn(api, "storeGeneratedVideo").mockResolvedValue(stored);
    discard = spyOn(media, "deleteStoredMedia").mockResolvedValue(undefined);
    claim = spyOn(media, "claimStoredMedia").mockImplementation(() => {});
});
afterEach(() => {
    disconnects.splice(0).forEach((disconnect) => disconnect());
    create.mockRestore(); poll.mockRestore(); store.mockRestore(); discard.mockRestore(); claim.mockRestore();
    useWorkbenchAgentStore.setState({ tasks: oldAgentTasks });
});

test("generation preserves its request snapshot and original Agent owner", async () => {
    const h = harness();
    const m = h.mount();
    await flush();
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "original", run: true })!;
    const nextAgentId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "next", run: true })!;
    const initial = { ...log(), agentTaskId };
    await m.view.generate(initial, config);
    expect(create.mock.calls[0]).toEqual([config, initial.prompt, initial.references]);
    expect(poll.mock.calls[0][0]).toBe(config);
    expect(h.rows.get("a")?.agentTaskId).toBe(agentTaskId);
    expect(h.rows.get("a")?.video?.storageKey).toBe(stored.storageKey);
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("succeeded");
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === nextAgentId)?.status).toBe("queued");
    expect(m.callbacks.onSuccess).toHaveBeenCalledTimes(1);
    expect(m.callbacks.onRunning.mock.calls.at(-1)).toEqual([false]);
    expect(discard).not.toHaveBeenCalled();
});

test.each([undefined, "preview-b"])("switching view to %s keeps old completion in its own log", async (id) => {
    const query = deferred<VideoGenerationTaskState>();
    poll.mockReturnValue(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush();
    m.view.select(id); m.callbacks.onResult.mockClear();
    query.resolve(complete); await pending;
    expect(h.rows.get("a")?.status).toBe("success");
    expect(m.callbacks.onResult).not.toHaveBeenCalled();
    expect(m.callbacks.onSuccess).not.toHaveBeenCalled();
    expect(m.callbacks.onRunning.mock.calls.at(-1)).toEqual([false]);
});

test("a late creation response stays in the original session's log", async () => {
    const creation = deferred<VideoGenerationTask>(); create.mockReturnValue(creation.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config);
    m.view.select(); m.callbacks.onResult.mockClear();
    creation.resolve(task); await pending;
    expect(h.rows.get("a")?.task).toEqual(task);
    expect(m.callbacks.onResult).not.toHaveBeenCalled();
    expect(m.callbacks.onSuccess).not.toHaveBeenCalled();
});

test.each([false, true])("creation after unmount retains its task ID, remountBeforeResponse=%s", async (earlyMount) => {
    const creation = deferred<VideoGenerationTask>(); create.mockReturnValue(creation.promise);
    const h = harness(); const first = h.mount(); await flush();
    const pending = first.view.generate(log(), config); first.disconnect();
    first.callbacks.onResult.mockClear(); first.callbacks.onRunning.mockClear();
    let next = earlyMount ? h.mount() : undefined; await flush();
    creation.resolve(task); await pending; await flush();
    if (!earlyMount) {
        expect(h.rows.get("a")?.status).toBe("pending");
        expect(h.rows.get("a")?.task).toEqual(task);
        expect(poll).not.toHaveBeenCalled();
        next = h.mount(); await flush();
    }
    expect(first.callbacks.onResult).not.toHaveBeenCalled();
    expect(first.callbacks.onRunning).not.toHaveBeenCalled();
    expect(first.callbacks.onSuccess).not.toHaveBeenCalled();
    expect(next?.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1); expect(store).toHaveBeenCalledTimes(1);
});

test("unmount cancels local queries; a remount ignores the old late response", async () => {
    const stale = deferred<VideoGenerationTaskState>();
    const current = deferred<VideoGenerationTaskState>();
    poll.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const h = harness(); const first = h.mount(); await flush();
    const pending = first.view.generate(log(), config); await flush();
    const signal = poll.mock.calls[0][2]?.signal; first.disconnect();
    expect(signal?.aborted).toBe(true);
    const next = h.mount(); await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    stale.resolve(complete); await pending;
    expect(store).not.toHaveBeenCalled();
    current.resolve(complete); await flush();
    expect(store).toHaveBeenCalledTimes(1);
    expect(next.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
});

test("StrictMode reconnect does not claim the same media storage twice", async () => {
    const saving = deferred<UploadedFile>(); store.mockReturnValue(saving.promise);
    const h = harness([log("a", task)]); const m = h.mount(); await flush();
    expect(store).toHaveBeenCalledTimes(1);
    m.disconnect(); const reconnect = m.view.connect(); disconnects.push(reconnect); await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    saving.resolve(stored); await flush();
    expect(store).toHaveBeenCalledTimes(1);
    expect(h.rows.get("a")?.status).toBe("success");
    expect(m.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
});

test("storage already started on an old mount finishes one durable result for a remount", async () => {
    const saving = deferred<UploadedFile>(); store.mockReturnValue(saving.promise);
    const h = harness(); const first = h.mount(); await flush();
    const pending = first.view.generate(log(), config); await flush(); first.disconnect();
    first.callbacks.onResult.mockClear();
    const next = h.mount(); await flush();
    saving.resolve(stored); await pending; await flush();
    expect(first.callbacks.onResult).not.toHaveBeenCalled();
    expect(next.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
    expect(poll).toHaveBeenCalledTimes(1); expect(store).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
});

test.each(["completed", "failed"])("deleting a pending query prevents late %s resurrection", async (status) => {
    const query = deferred<VideoGenerationTaskState>(); poll.mockReturnValue(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush();
    await m.view.remove(["a"]);
    expect(poll.mock.calls[0][2]?.signal?.aborted).toBe(true);
    query.resolve(status === "completed" ? complete : { status: "failed", error: "late" });
    await pending;
    expect(h.rows.has("a")).toBe(false); expect(store).not.toHaveBeenCalled();
    expect(h.events.slice(-2)).toEqual(["remove:a", "cleanup"]);
    expect(m.callbacks.onSuccess).not.toHaveBeenCalled(); expect(m.callbacks.onError).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
});

test("deletion waits behind an already-started pending write, and the removal wins", async () => {
    const writing = deferred<void>();
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockImplementation(async (item) => { await writing.promise; h.rows.set(item.id, item); });
    const pending = m.view.generate(log(), config); await flush();
    const removal = m.view.remove(["a"]); await flush();
    expect(h.storage.remove).not.toHaveBeenCalled();
    writing.resolve(); await Promise.all([pending, removal]);
    expect(h.rows.has("a")).toBe(false); expect(poll).not.toHaveBeenCalled();
    expect(h.storage.cleanup).toHaveBeenCalledTimes(1);
});

test("delete during media storage removes only its unclaimed result", async () => {
    const saving = deferred<UploadedFile>(); store.mockReturnValue(saving.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush();
    await m.view.remove(["a"]); saving.resolve(stored); await pending;
    expect(h.rows.has("a")).toBe(false);
    expect(h.storage.write.mock.calls.map(([item]) => item.status)).toEqual(["pending"]);
    expect([...discard.mock.calls[0][0]]).toEqual([stored.storageKey]);
    expect(m.callbacks.onSuccess).not.toHaveBeenCalled();
});

test("delete during a successful log write uses reference-aware cleanup for its persisted media", async () => {
    const writing = deferred<void>();
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockImplementation(async (item) => { if (item.status === "success") await writing.promise; h.rows.set(item.id, item); });
    const pending = m.view.generate(log(), config); await flush();
    const removal = m.view.remove(["a"]); await flush();
    writing.resolve(); await Promise.all([pending, removal]);
    expect(h.rows.has("a")).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(h.storage.cleanup).toHaveBeenCalledTimes(1);
    expect(m.callbacks.onSuccess).not.toHaveBeenCalled();
});

test("deleting a saved log uses reference-aware cleanup after removal, never raw key deletion", async () => {
    const saved = { ...log(), status: "success" as const, video: { ...stored, id: "video", durationMs: 1, width: 640, height: 480 } };
    const h = harness([saved]); const m = h.mount(); await flush();
    h.storage.cleanup.mockImplementation(async () => { expect(h.rows.has("a")).toBe(false); });
    await m.view.remove(["a"]);
    expect(h.storage.cleanup).toHaveBeenCalledTimes(1); expect(discard).not.toHaveBeenCalled();
});

test.each(["query", "storage", "persistence"])("a %s failure retries the existing task instead of paying for another creation", async (phase) => {
    const h = harness(); const m = h.mount(); await flush();
    if (phase === "query") poll.mockRejectedValueOnce(new Error("query failed"));
    if (phase === "storage") store.mockRejectedValueOnce(new Error("storage failed"));
    if (phase === "persistence") h.storage.write.mockImplementation(async (item) => { if (item.status === "success") throw new Error("write failed"); h.rows.set(item.id, item); });
    await m.view.generate(log(), config);
    const failed = h.rows.get("a")!;
    expect(failed.status).toBe("failed"); expect(failed.retryable).toBe(true); expect(failed.task).toEqual(task);
    if (phase === "persistence") {
        expect([...discard.mock.calls[0][0]]).toEqual([stored.storageKey]);
        h.storage.write.mockImplementation(async (item) => { h.rows.set(item.id, item); });
    }
    await m.view.retry(failed);
    expect(create).toHaveBeenCalledTimes(1);
    expect(poll.mock.calls.every(([, value]) => value.id === task.id)).toBe(true);
    expect(h.rows.get("a")?.status).toBe("success");
});

test("a remote terminal failure does not offer query-only retry", async () => {
    poll.mockResolvedValue({ status: "failed", error: "remote rejected" });
    const h = harness(); const m = h.mount(); await flush();
    await m.view.generate(log(), config);
    expect(h.rows.get("a")?.retryable).toBe(false);
    await m.view.retry(h.rows.get("a")!);
    expect(poll).toHaveBeenCalledTimes(1);
});

test("a refresh failure after a successful write does not delete owned media", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.read.mockRejectedValue(new Error("read failed"));
    await m.view.generate(log(), config);
    expect(h.rows.get("a")?.status).toBe("success"); expect(discard).not.toHaveBeenCalled();
    expect(m.callbacks.onSuccess).toHaveBeenCalledTimes(1);
});

test("the latest refresh wins when reads complete in reverse order", async () => {
    const h = harness(); const m = h.mount(); await flush();
    const old = deferred<GenerationLog[]>(); const fresh = deferred<GenerationLog[]>();
    h.storage.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = h.manager.refresh(); const last = h.manager.refresh();
    fresh.resolve([{ ...log("new"), status: "success" }]); await last;
    old.resolve([log("old", task)]); await first;
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0].map((item) => item.id)).toEqual(["new"]);
    expect(poll).not.toHaveBeenCalled();
});

test("a pending creation handoff retains its snapshot while a newer refresh carries mount recovery", async () => {
    const initialRead = deferred<GenerationLog[]>(); const query = deferred<VideoGenerationTaskState>();
    const h = harness(); h.storage.read.mockReturnValueOnce(initialRead.promise);
    poll.mockReturnValue(query.promise); const m = h.mount();
    const pending = m.view.generate(log(), config); await flush();
    expect(poll).toHaveBeenCalledTimes(1); expect(poll.mock.calls[0][0]).toBe(config);
    initialRead.resolve([log("a", task)]); await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    query.resolve(complete); await pending;
    expect(h.rows.get("a")?.status).toBe("success");
});

test("a delete refresh keeps mount recovery for other logs without reviving the deleted task", async () => {
    const firstRead = deferred<GenerationLog[]>(); const query = deferred<VideoGenerationTaskState>();
    const h = harness([log("a", task), log("b", { ...task, id: "remote-b" })]);
    h.storage.read.mockReturnValueOnce(firstRead.promise); poll.mockReturnValue(query.promise);
    const m = h.mount(); await m.view.remove(["b"]);
    expect(poll).toHaveBeenCalledTimes(1); expect(poll.mock.calls[0][1].id).toBe("remote-a");
    firstRead.resolve([log("a", task), log("b", task)]); await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    query.resolve(complete); await flush();
    expect(h.rows.has("b")).toBe(false);
});

test("active background work keeps generation disabled after switching the view", async () => {
    const query = deferred<VideoGenerationTaskState>(); poll.mockReturnValue(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush(); m.view.select();
    await m.view.generate(log("b"), config);
    expect(create).toHaveBeenCalledTimes(1); expect(m.callbacks.onRunning.mock.calls.at(-1)).toEqual([true]);
    query.resolve(complete); await pending;
});

test("polling retains 120 attempts and 2500 ms intervals, then preserves the remote ID for manual retry", async () => {
    poll.mockResolvedValue({ status: "pending" });
    const timers = spyOn(globalThis, "setTimeout").mockImplementation((callback) => { queueMicrotask(callback as () => void); return 0 as never; });
    try {
        const h = harness(); const m = h.mount(); await flush();
        await m.view.generate(log(), config);
        expect(poll).toHaveBeenCalledTimes(120); expect(timers).toHaveBeenCalledTimes(119);
        expect(timers.mock.calls.every(([, delay]) => delay === 2500)).toBe(true);
        expect(h.rows.get("a")?.retryable).toBe(true); expect(h.rows.get("a")?.task).toEqual(task);
    } finally { timers.mockRestore(); }
});

test("unmount cancels a poll wait without recording an error or leaving its abort listener", async () => {
    poll.mockResolvedValue({ status: "pending" });
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(() => 1 as never);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
        const h = harness(); const m = h.mount(); await flush();
        const pending = m.view.generate(log(), config); await flush();
        const signal = poll.mock.calls[0][2]!.signal!; const removeListener = spyOn(signal, "removeEventListener");
        m.disconnect(); await pending;
        expect(clear).toHaveBeenCalledWith(1); expect(removeListener).toHaveBeenCalledTimes(1);
        expect(h.rows.get("a")?.status).toBe("pending"); expect(m.callbacks.onError).not.toHaveBeenCalled();
        removeListener.mockRestore();
    } finally { timers.mockRestore(); clear.mockRestore(); }
});

test("a failed deletion keeps the original row visible and can be retried", async () => {
    const saved = { ...log(), status: "success" as const };
    const h = harness([saved]); const m = h.mount(); await flush();
    h.storage.remove.mockRejectedValueOnce(new Error("delete failed"));
    await m.view.remove(["a"]);
    expect(h.rows.has("a")).toBe(true);
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0].map((item) => item.id)).toEqual(["a"]);
    expect(m.callbacks.onError.mock.calls.at(-1)).toEqual(["delete failed"]);
    expect(h.storage.cleanup).not.toHaveBeenCalled();
    await m.view.remove(["a"]);
    expect(h.rows.has("a")).toBe(false); expect(h.storage.cleanup).toHaveBeenCalledTimes(1);
});

test("partially failed deletion removes successful IDs and restores only failed rows", async () => {
    const h = harness(["a", "b"].map((id) => ({ ...log(id), status: "success" as const })));
    const m = h.mount(); await flush();
    h.storage.remove.mockImplementation(async (id) => { if (id === "b") throw new Error("b failed"); h.rows.delete(id); });
    await m.view.remove(["a", "b"]);
    expect([...h.rows.keys()]).toEqual(["b"]);
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0].map((item) => item.id)).toEqual(["b"]);
    expect(h.storage.cleanup).toHaveBeenCalledTimes(1);
});

test("failed deletion resumes its canceled query without a second creation", async () => {
    const stale = deferred<VideoGenerationTaskState>();
    poll.mockReturnValueOnce(stale.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush();
    h.storage.remove.mockRejectedValueOnce(new Error("delete failed"));
    await m.view.remove(["a"]);
    expect(poll).toHaveBeenCalledTimes(1);
    stale.resolve(complete); await pending; await flush();
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(2); expect(store).toHaveBeenCalledTimes(1);
    expect(h.rows.get("a")?.status).toBe("success");
});

test("a failed delete waits for canceled storage cleanup before restoring its query", async () => {
    const saving = deferred<UploadedFile>(); store.mockReturnValueOnce(saving.promise);
    const h = harness(); const m = h.mount(); await flush();
    const pending = m.view.generate(log(), config); await flush();
    h.storage.remove.mockRejectedValueOnce(new Error("delete failed"));
    await m.view.remove(["a"]);
    expect(store).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1);
    saving.resolve({ ...stored, storageKey: "video:discarded" }); await pending; await flush();
    expect([...discard.mock.calls[0][0]]).toEqual(["video:discarded"]);
    expect(store).toHaveBeenCalledTimes(2); expect(h.rows.get("a")?.video?.storageKey).toBe(stored.storageKey);
});

test("deleted rows cannot be restarted through a stale retry callback", async () => {
    poll.mockRejectedValueOnce(new Error("temporary"));
    const h = harness(); const m = h.mount(); await flush();
    await m.view.generate(log(), config); const old = h.rows.get("a")!;
    await m.view.remove(["a"]); await m.view.retry(old);
    expect(poll).toHaveBeenCalledTimes(1); expect(h.rows.has("a")).toBe(false);
});

test("a stale cleanup cannot disconnect a newer StrictMode connection", async () => {
    const h = harness(); const m = h.mount(); await flush(); m.disconnect();
    const reconnect = m.view.connect(); disconnects.push(reconnect); await flush();
    m.disconnect();
    await m.view.generate(log(), config);
    expect(create).toHaveBeenCalledTimes(1); expect(h.rows.get("a")?.status).toBe("success");
});

test("read failure preserves existing logs, reports once, and allows a later refresh", async () => {
    const saved = { ...log(), status: "success" as const };
    const h = harness([saved]); const m = h.mount(); await flush();
    h.storage.read.mockRejectedValueOnce(new Error("read unavailable"));
    await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([saved]);
    expect(m.callbacks.onError.mock.calls.at(-1)).toEqual(["read unavailable"]);
    h.rows.clear(); await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([]);
});

test("an obsolete read failure does not report into a later connection", async () => {
    const read = deferred<GenerationLog[]>();
    const h = harness(); h.storage.read.mockReturnValueOnce(read.promise);
    const first = h.mount(); first.disconnect(); const next = h.mount(); await flush();
    read.reject(new Error("obsolete")); await flush();
    expect(first.callbacks.onError).not.toHaveBeenCalled(); expect(next.callbacks.onError).not.toHaveBeenCalled();
});

test("same-frame busy rejection marks the second Agent task failed", async () => {
    const query = deferred<VideoGenerationTaskState>(); poll.mockReturnValue(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const firstId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "first", run: true })!;
    const secondId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "second", run: true })!;
    const pending = m.view.generate({ ...log(), agentTaskId: firstId }, config);
    await m.view.generate({ ...log("b"), agentTaskId: secondId }, config); await flush();
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === secondId)?.status).toBe("failed");
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === firstId)?.status).toBe("running");
    expect(create).toHaveBeenCalledTimes(1);
    query.resolve(complete); await pending;
});

test("a deletion failure after unmount keeps data and produces no late UI message", async () => {
    const removal = deferred<void>();
    const h = harness([{ ...log(), status: "success" }]); const m = h.mount(); await flush();
    h.storage.remove.mockReturnValue(removal.promise);
    const pending = m.view.remove(["a"]); m.disconnect();
    removal.reject(new Error("late deletion error")); await pending;
    expect(h.rows.has("a")).toBe(true); expect(m.callbacks.onError).not.toHaveBeenCalled();
});

test("failed removal after a success write preserves the owned file and restores its result", async () => {
    const writing = deferred<void>();
    const h = harness(); const m = h.mount(); await flush();
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "first", run: true })!;
    h.storage.write.mockImplementation(async (item) => { if (item.status === "success") await writing.promise; h.rows.set(item.id, item); });
    h.storage.remove.mockRejectedValueOnce(new Error("delete failed"));
    const pending = m.view.generate({ ...log(), agentTaskId }, config); await flush();
    const removal = m.view.remove(["a"]); writing.resolve(); await Promise.all([pending, removal]); await flush();
    expect(h.rows.get("a")?.video?.storageKey).toBe(stored.storageKey);
    expect(h.rows.get("a")?.status).toBe("success");
    expect(discard).not.toHaveBeenCalled();
    expect(m.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("succeeded");
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1); expect(store).toHaveBeenCalledTimes(1);
});


test("a remount updates a cached pending view from the authoritative completed log", async () => {
    const stale = deferred<VideoGenerationTaskState>(); poll.mockReturnValue(stale.promise);
    const h = harness([log("a", task)]); const first = h.mount(); await flush();
    first.disconnect();
    const saved = { ...log("a", task), status: "success" as const, video: { ...stored, id: "saved", durationMs: 1, width: 640, height: 480 } };
    h.rows.set("a", saved);
    const next = h.mount(); await flush();
    expect(next.callbacks.onResult.mock.calls.at(-1)?.[0].status).toBe("success");
    expect(poll).toHaveBeenCalledTimes(1);
    stale.resolve(complete); await flush();
    expect(store).not.toHaveBeenCalled();
});

test("a failure log already committing on unmount updates only its original Agent owner", async () => {
    const writing = deferred<void>();
    const h = harness(); const m = h.mount(); await flush();
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "failed", run: true })!;
    poll.mockRejectedValueOnce(new Error("query failed"));
    h.storage.write.mockImplementation(async (item) => { if (item.status === "failed") await writing.promise; h.rows.set(item.id, item); });
    const pending = m.view.generate({ ...log(), agentTaskId }, config); await flush();
    m.disconnect(); m.callbacks.onResult.mockClear();
    writing.resolve(); await pending;
    expect(h.rows.get("a")?.status).toBe("failed");
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("failed");
    expect(m.callbacks.onResult).not.toHaveBeenCalled(); expect(m.callbacks.onError).not.toHaveBeenCalled();
});

test("a completed task cannot be stored again through an outdated retry callback", async () => {
    poll.mockRejectedValueOnce(new Error("temporary"));
    const h = harness(); const m = h.mount(); await flush();
    await m.view.generate(log(), config); const failed = h.rows.get("a")!;
    await m.view.retry(failed); await m.view.retry(failed);
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(2); expect(store).toHaveBeenCalledTimes(1);
});


test("deleting a log keeps current draft references in live cleanup roots only while connected", async () => {
    const h = harness([{ ...log(), status: "success" }]); const m = h.mount(); await flush();
    const references = [{ ...log().references[0], storageKey: "image:still-in-draft" }];
    m.callbacks.getReferences.mockReturnValue(references);
    await m.view.remove(["a"]);
    const roots = h.storage.cleanup.mock.calls[0][0];
    expect(roots()).toEqual([references]);
    const changed = [{ ...references[0], storageKey: "image:next-draft" }];
    m.callbacks.getReferences.mockReturnValue(changed);
    expect(roots()).toEqual([changed]);
    m.disconnect();
    expect(roots()).toEqual([]);
});


test("new media becomes claimed only after its success log write, before a queued deletion", async () => {
    const writing = deferred<void>();
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockImplementation(async (item) => {
        if (item.status === "success") await writing.promise;
        h.rows.set(item.id, item); h.events.push("written:" + item.status);
    });
    claim.mockImplementation((key) => { expect(h.rows.get("a")?.video?.storageKey).toBe(key); h.events.push("claimed"); });
    const pending = m.view.generate(log(), config); await flush();
    expect(claim).not.toHaveBeenCalled();
    const removal = m.view.remove(["a"]); writing.resolve();
    await Promise.all([pending, removal]);
    expect(h.events).toEqual(["written:pending", "written:success", "claimed", "remove:a", "cleanup"]);
    expect(claim).toHaveBeenCalledWith(stored.storageKey); expect(discard).not.toHaveBeenCalled();
});

test("media remains unclaimed when its success log write fails", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockImplementation(async (item) => { if (item.status === "success") throw new Error("write failed"); h.rows.set(item.id, item); });
    await m.view.generate(log(), config);
    expect(claim).not.toHaveBeenCalled(); expect([...discard.mock.calls[0][0]]).toEqual([stored.storageKey]);
    expect(h.rows.get("a")?.retryable).toBe(true);
});

test("successfully deleting a pending Agent log stops tracking without claiming remote cancellation", async () => {
    const query = deferred<VideoGenerationTaskState>(); poll.mockReturnValue(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "pending", run: true })!;
    const pending = m.view.generate({ ...log(), agentTaskId }, config); await flush();
    await m.view.remove(["a"]);
    const agent = useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)!;
    expect(agent.status).toBe("failed");
    expect(agent.error).toMatch(/记录已删除|Record deleted/);
    expect(agent.error).not.toMatch(/远端已取消|remote.*cancell?ed/i);
    query.resolve(complete); await pending;
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("failed");
    expect(store).not.toHaveBeenCalled();
});

test.each(["succeeded", "failed"] as const)("deleting terminal history preserves its Agent %s state", async (status) => {
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "done", run: true })!;
    useWorkbenchAgentStore.getState().updateTask(agentTaskId, { status, error: status === "failed" ? "original failure" : undefined });
    const before = useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId);
    const h = harness([{ ...log(), status: status === "succeeded" ? "success" : "failed", agentTaskId }]);
    const m = h.mount(); await flush(); await m.view.remove(["a"]);
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)).toEqual(before);
});

test("failed pending-log deletion retains the Agent owner while its original task resumes", async () => {
    const query = deferred<VideoGenerationTaskState>(); poll.mockReturnValueOnce(query.promise);
    const h = harness(); const m = h.mount(); await flush();
    const agentTaskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "pending", run: true })!;
    const pending = m.view.generate({ ...log(), agentTaskId }, config); await flush();
    h.storage.remove.mockRejectedValueOnce(new Error("delete failed")); await m.view.remove(["a"]);
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("running");
    query.resolve(complete); await pending; await flush();
    expect(useWorkbenchAgentStore.getState().tasks.find((item) => item.id === agentTaskId)?.status).toBe("succeeded");
    expect(create).toHaveBeenCalledTimes(1);
});

test("an old retry callback cannot restart a task after a newer remote terminal failure", async () => {
    poll.mockRejectedValueOnce(new Error("temporary query failure"));
    const h = harness(); const m = h.mount(); await flush();
    await m.view.generate(log(), config);
    const previousFailure = h.rows.get("a")!;
    expect(previousFailure.retryable).toBe(true);
    poll.mockResolvedValueOnce({ status: "failed", error: "remote terminal failure" });
    await m.view.retry(previousFailure);
    expect(h.rows.get("a")?.retryable).toBe(false);
    await m.view.retry(previousFailure);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1); expect(store).not.toHaveBeenCalled();
    expect(h.rows.get("a")?.error).toBe("remote terminal failure");
});

test("retry reads request metadata from the current log rather than the caller snapshot", async () => {
    poll.mockRejectedValueOnce(new Error("temporary query failure"));
    const h = harness(); const m = h.mount(); await flush();
    await m.view.generate(log(), config);
    const current = h.rows.get("a")!;
    const outdated = { ...current, prompt: "outdated prompt", config: { ...current.config, videoSeconds: "15" } };
    await m.view.retry(outdated);
    expect(m.callbacks.configFor.mock.calls.at(-1)?.[0]).toEqual(current);
    expect(poll.mock.calls.at(-1)?.[0].videoSeconds).toBe("6");
    expect(h.rows.get("a")?.prompt).toBe(current.prompt);
});

test("continuous log-write failure retains the paid task for a visible retry after storage recovers", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockRejectedValue(new Error("storage unavailable"));
    await m.view.generate(log(), config);
    const failed = m.callbacks.onResult.mock.calls.at(-1)![0];
    expect(failed.task).toEqual(task); expect(failed.retryable).toBe(true);
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([failed]);
    expect(h.rows.size).toBe(0);
    await m.view.retry(failed);
    expect(m.callbacks.onError).toHaveBeenCalledTimes(2);
    expect(m.callbacks.onError.mock.calls.at(-1)).toEqual(["storage unavailable"]);
    expect(create).toHaveBeenCalledTimes(1); expect(poll).not.toHaveBeenCalled();
    h.storage.write.mockImplementation(async (item) => { h.rows.set(item.id, item); });
    await m.view.retry(failed);
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1);
    expect(poll.mock.calls[0][1]).toEqual(task); expect(h.rows.get("a")?.status).toBe("success");
    await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0].map((item) => item.status)).toEqual(["success"]);
});

test("deleting an unpersisted failure invalidates its old retry and clears the session cache", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockRejectedValue(new Error("storage unavailable"));
    await m.view.generate(log(), config);
    const failed = m.callbacks.onResult.mock.calls.at(-1)![0];
    await m.view.remove(["a"]);
    h.storage.write.mockImplementation(async (item) => { h.rows.set(item.id, item); });
    await m.view.retry(failed); await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1); expect(poll).not.toHaveBeenCalled(); expect(h.rows.size).toBe(0);
});

test("an unpersisted paid task survives fresh reads and remount in the same session", async () => {
    const h = harness(); const first = h.mount(); await flush();
    h.storage.write.mockRejectedValue(new Error("storage unavailable"));
    await first.view.generate(log(), config);
    const failed = first.callbacks.onResult.mock.calls.at(-1)![0];
    await h.manager.refresh();
    expect(first.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([failed]);
    first.disconnect(); const next = h.mount(); await flush();
    expect(next.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([failed]);
    h.storage.write.mockImplementation(async (item) => { h.rows.set(item.id, item); });
    await next.view.retry(failed);
    expect(h.rows.get("a")?.status).toBe("success");
    expect(create).toHaveBeenCalledTimes(1); expect(poll).toHaveBeenCalledTimes(1);
});

test("a failed deletion retains the unpersisted authority until it can be retried", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockRejectedValue(new Error("storage unavailable"));
    await m.view.generate(log(), config); const failed = m.callbacks.onResult.mock.calls.at(-1)![0];
    h.storage.remove.mockRejectedValueOnce(new Error("delete unavailable"));
    await m.view.remove(["a"]); await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0]).toEqual([failed]);
    expect(m.callbacks.onError.mock.calls.at(-1)).toEqual(["delete unavailable"]);
    h.storage.write.mockImplementation(async (item) => { h.rows.set(item.id, item); });
    await m.view.retry(failed);
    expect(h.rows.get("a")?.status).toBe("success");
    expect(create).toHaveBeenCalledTimes(1);
});

test("an unpersisted remote terminal failure invalidates an older retryable cache entry", async () => {
    const h = harness(); const m = h.mount(); await flush();
    h.storage.write.mockRejectedValue(new Error("storage unavailable"));
    await m.view.generate(log(), config); const failed = m.callbacks.onResult.mock.calls.at(-1)![0];
    h.storage.write.mockImplementation(async (item) => { if (item.status === "failed") throw new Error("failure log unavailable"); h.rows.set(item.id, item); });
    poll.mockResolvedValueOnce({ status: "failed", error: "remote terminal failure" });
    await m.view.retry(failed); await h.manager.refresh();
    expect(m.callbacks.onLogs.mock.calls.at(-1)?.[0][0].retryable).toBe(false);
    await m.view.retry(failed);
    expect(poll).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1);
    expect(m.callbacks.onResult.mock.calls.at(-1)?.[0].error).toBe("remote terminal failure");
});
