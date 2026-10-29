import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { claimStoredMedia, deleteStoredMedia } from "@/services/file-storage";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeneratedVideo = { id: string; url: string; storageKey: string; durationMs: number; width: number; height: number; bytes: number; mimeType: string };
export type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">;
export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
    retryable?: boolean;
    agentTaskId?: string;
};

type LogStorage = {
    read: () => Promise<GenerationLog[]>;
    write: (log: GenerationLog) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    cleanup: (retainedMedia: () => unknown) => Promise<void>;
};
type ViewCallbacks = {
    configFor: (log: GenerationLog) => AiConfig;
    getReferences: () => ReferenceImage[];
    onLogs: (logs: GenerationLog[]) => void;
    onRunning: (running: boolean) => void;
    onResult: (log: GenerationLog) => void;
    onSuccess: () => void;
    onError: (message: string) => void;
};
type View = { callbacks: ViewCallbacks; id?: string; adoptPending: boolean; connection: number };
type Run = { log: GenerationLog; config: AiConfig; controller: AbortController; creating: boolean; committing: boolean; settled: Promise<void> };

// Shared only by mounts of the video workbench: durable logs own results; a view owns UI effects.
export function createVideoGenerationTasks(storage: LogStorage) {
    const views = new Set<View>();
    const active = new Map<string, Run>();
    const writes = new Map<string, Promise<unknown>>();
    const deleted = new Set<string>();
    const unsaved = new Map<string, GenerationLog>();
    let logs: GenerationLog[] = [];
    let refreshVersion = 0;
    let resumePending = false;

    const notifyRunning = () => views.forEach(({ callbacks }) => callbacks.onRunning(active.size > 0));
    const isCurrent = (run: Run) => active.get(run.log.id) === run && !deleted.has(run.log.id);
    const notifyResult = (log: GenerationLog, finished = false) => {
        for (const view of views) {
            if (view.id !== log.id) continue;
            view.callbacks.onResult(log);
            if (finished && log.status === "success") view.callbacks.onSuccess();
            if (finished && log.status === "failed") view.callbacks.onError(log.error || i18n.t("workbench.generationFailed"));
        }
    };
    const notifyLogs = () => {
        for (const view of views) {
            view.callbacks.onLogs(logs);
            const selected = logs.find((log) => log.id === view.id);
            if (selected) view.callbacks.onResult(selected);
            if (view.adoptPending && !view.id) {
                const pending = logs.find((log) => log.status === "pending" && log.task);
                if (pending) {
                    view.id = pending.id;
                    view.adoptPending = false;
                    view.callbacks.onResult(pending);
                }
            }
        }
    };
    const rememberLog = (log: GenerationLog) => {
        logs = [log, ...logs.filter((item) => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt);
        notifyLogs();
    };
    const serial = <T,>(id: string, operation: () => Promise<T>) => {
        const pending = (writes.get(id) || Promise.resolve()).catch(() => undefined).then(operation);
        writes.set(id, pending);
        void pending.finally(() => { if (writes.get(id) === pending) writes.delete(id); }).catch(() => undefined);
        return pending;
    };
    const refresh = async (recover = false) => {
        const version = ++refreshVersion;
        resumePending ||= recover;
        let next: GenerationLog[];
        try {
            next = await storage.read();
        } catch (error) {
            if (version === refreshVersion) views.forEach(({ callbacks }) => callbacks.onError(error instanceof Error ? error.message : i18n.t("workbench.generationFailed")));
            return;
        }
        if (version !== refreshVersion) return;
        const currentLogs = new Map(next.map((log) => [log.id, log]));
        unsaved.forEach((log, id) => currentLogs.set(id, log));
        logs = [...currentLogs.values()].filter((log) => !deleted.has(log.id)).sort((a, b) => b.createdAt - a.createdAt);
        notifyLogs();
        if (resumePending && views.size) {
            resumePending = false;
            const view = views.values().next().value!;
            for (const log of logs) {
                if (log.status === "pending" && log.task) void start(log, view.callbacks.configFor(log));
            }
        }
    };
    const save = async (log: GenerationLog) => {
        const saved = await serial(log.id, async () => {
            if (deleted.has(log.id)) return false;
            await storage.write(log);
            if (log.status === "success" && log.video?.storageKey) claimStoredMedia(log.video.storageKey);
            return true;
        });
        if (saved) unsaved.delete(log.id);
        if (!saved || deleted.has(log.id)) return saved;
        rememberLog(log);
        // Reading errors cannot turn a successfully persisted media result into an unclaimed file.
        void refresh().catch(() => undefined);
        return true;
    };
    const updateAgent = (log: GenerationLog) => {
        if (!log.agentTaskId) return;
        useWorkbenchAgentStore.getState().updateTask(log.agentTaskId, log.status === "success"
            ? { status: "succeeded", successCount: 1, failCount: 0, error: undefined }
            : log.status === "failed"
                ? { status: "failed", successCount: 0, failCount: 1, error: log.error }
                : { status: "running", error: undefined });
    };
    const start = async (initial: GenerationLog, config: AiConfig, create = false) => {
        if (active.has(initial.id) || deleted.has(initial.id)) return;
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => { finish = resolve; });
        const run: Run = { log: { ...initial, status: "pending", error: undefined }, config, controller: new AbortController(), creating: create, committing: false, settled };
        active.set(initial.id, run);
        notifyRunning();
        notifyResult(run.log);
        updateAgent(run.log);
        let unclaimedKey = "";
        let terminalFailure = false;
        try {
            if (create) {
                // Keep a submitted creation response even after navigation so its remote ID can be recovered.
                run.log.task = await createVideoGenerationTask(config, run.log.prompt, run.log.references);
                if (!isCurrent(run) || !await save(run.log)) return;
                run.creating = false;
            } else if (initial.status === "failed") {
                if (!await save(run.log)) return;
            }
            if (!isCurrent(run) || !views.size || !run.log.task) return;
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(config, run.log.task, { signal: run.controller.signal });
                if (!isCurrent(run) || run.controller.signal.aborted) return;
                if (state.status === "completed") {
                    run.committing = true;
                    const stored = await storeGeneratedVideo(state.result);
                    unclaimedKey = stored.storageKey;
                    if (!isCurrent(run)) return;
                    const video: GeneratedVideo = { ...stored, id: nanoid(), durationMs: Date.now() - run.log.createdAt, width: stored.width || 1280, height: stored.height || 720 };
                    const complete: GenerationLog = { ...run.log, status: "success", durationMs: video.durationMs, video, error: undefined, retryable: false };
                    if (!await save(complete)) return;
                    // Once persisted, the file may be shared by another owner; only reference-aware GC may remove it.
                    unclaimedKey = "";
                    if (!isCurrent(run)) return;
                    updateAgent(complete);
                    notifyResult(complete, true);
                    return;
                }
                if (state.status === "failed") {
                    terminalFailure = true;
                    throw new Error(state.error);
                }
                if (attempt === 119) throw new Error(i18n.t("videoWorkbench.timeout"));
                await waitForNextPoll(run.controller.signal);
            }
        } catch (error) {
            if (!isCurrent(run) || (run.controller.signal.aborted && !run.committing)) return;
            run.committing = true;
            const failed: GenerationLog = { ...run.log, status: "failed", durationMs: Date.now() - run.log.createdAt, retryable: Boolean(run.log.task) && !terminalFailure, error: error instanceof Error ? error.message : i18n.t("workbench.generationFailed") };
            try {
                await save(failed);
            } catch {
                if (isCurrent(run)) {
                    // Persistence failure must not lose a paid remote task or trust a later caller's stale snapshot.
                    unsaved.set(failed.id, failed);
                    rememberLog(failed);
                }
            }
            if (!isCurrent(run)) return;
            updateAgent(failed);
            notifyResult(failed, true);
        } finally {
            if (unclaimedKey) await deleteStoredMedia([unclaimedKey]).catch(() => undefined);
            if (active.get(initial.id) === run) active.delete(initial.id);
            notifyRunning();
            finish();
        }
    };

    return {
        createView(callbacks: ViewCallbacks) {
            const view: View = { callbacks, adoptPending: true, connection: 0 };
            const select = (id?: string) => { view.id = id; view.adoptPending = false; };
            return {
                select,
                connect() {
                    const connection = ++view.connection;
                    views.add(view);
                    notifyLogs();
                    notifyRunning();
                    void refresh(true);
                    return () => {
                        if (connection !== view.connection) return;
                        views.delete(view);
                        if (views.size) return;
                        refreshVersion += 1;
                        resumePending = false;
                        for (const [id, run] of active) {
                            if (run.creating) continue;
                            run.controller.abort();
                            // A media/log commit already in progress finishes before a remount can reclaim its task.
                            if (!run.committing) active.delete(id);
                        }
                    };
                },
                generate(log: GenerationLog, config: AiConfig) {
                    if (!views.has(view) || active.size) {
                        if (log.agentTaskId) useWorkbenchAgentStore.getState().updateTask(log.agentTaskId, { status: "failed", error: i18n.t("videoWorkbench.busy") });
                        return Promise.resolve();
                    }
                    select(log.id);
                    return start(log, config, true);
                },
                retry(log: GenerationLog) {
                    const current = logs.find((item) => item.id === log.id);
                    if (!views.has(view) || active.size || !current || current.status === "success" || !current.retryable || !current.task || current.task.id !== log.task?.id) return Promise.resolve();
                    select(current.id);
                    return start(current, callbacks.configFor(current));
                },
                async remove(ids: string[]) {
                    ids = [...new Set(ids)].filter((id) => !deleted.has(id));
                    if (!ids.length) return;
                    const connection = view.connection;
                    const interrupted = new Map(ids.map((id) => [id, active.get(id)]));
                    const previousLogs = logs;
                    for (const id of ids) {
                        deleted.add(id);
                        active.get(id)?.controller.abort();
                        active.delete(id);
                    }
                    refreshVersion += 1;
                    notifyRunning();
                    const removed = await Promise.allSettled(ids.map((id) => serial(id, () => storage.remove(id))));
                    const removedIds = new Set(ids.filter((_, index) => removed[index].status === "fulfilled"));
                    for (const id of removedIds) {
                        unsaved.delete(id);
                        const previous = interrupted.get(id)?.log || previousLogs.find((log) => log.id === id);
                        if (previous?.status === "pending") updateAgent({ ...previous, status: "failed", error: i18n.t("videoWorkbench.trackingStopped") });
                    }
                    logs = logs.filter((log) => !removedIds.has(log.id));
                    // Earlier writes are settled and old runs lost ownership; no UUID tombstones need to outlive deletion.
                    ids.forEach((id) => deleted.delete(id));
                    refreshVersion += 1;
                    notifyLogs();
                    await refresh();
                    const failure = removed.find((result) => result.status === "rejected");
                    if (failure?.status === "rejected" && views.has(view) && view.connection === connection) callbacks.onError(failure.reason instanceof Error ? failure.reason.message : i18n.t("workbench.generationFailed"));
                    for (const id of ids.filter((id) => !removedIds.has(id))) {
                        const previous = interrupted.get(id);
                        const retained = logs.find((log) => log.id === id);
                        if (retained) {
                            notifyResult(retained);
                            if (retained.status !== "pending") updateAgent(retained);
                        }
                        // A failed deletion restores the prior task after its canceled query/storage has settled.
                        void (previous?.settled || Promise.resolve()).then(() => {
                            const log = logs.find((item) => item.id === id && item.status === "pending" && item.task);
                            const currentView = views.values().next().value;
                            if (log && currentView) void start(log, previous?.config || currentView.callbacks.configFor(log));
                        });
                    }
                    if (removedIds.size) await storage.cleanup(() => [...[...views].map(({ callbacks }) => callbacks.getReferences()), ...[...unsaved.values()].map((log) => log.references)]).catch((error) => {
                        if (views.has(view) && view.connection === connection) callbacks.onError(error instanceof Error ? error.message : i18n.t("workbench.generationFailed"));
                    });
                },
            };
        },
        refresh,
    };
}

function waitForNextPoll(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 2500);
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
    });
}
