import localforage from "localforage";

import type { SyncDeletedItem } from "@/lib/sync-merge";

export type GenerationLogKind = "image" | "video";

const stores = {
    image: localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_log_deletions" }),
    video: localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_log_deletions" }),
};
const logLocks = new Map<string, Promise<void>>();

export async function withGenerationLogLock<T>(kind: GenerationLogKind, id: string, work: () => Promise<T>) {
    const key = `${kind}:${id}`;
    const previous = logLocks.get(key) || Promise.resolve();
    const task = previous.catch(() => undefined).then(work);
    const tail = task.then(
        () => undefined,
        () => undefined,
    );
    logLocks.set(key, tail);
    try {
        return await task;
    } finally {
        if (logLocks.get(key) === tail) logLocks.delete(key);
    }
}

export async function recordGenerationLogDeletions(kind: GenerationLogKind, ids: Iterable<string>, deletedAt = new Date().toISOString()) {
    await mergeGenerationLogDeletions(
        kind,
        Array.from(new Set(ids), (id) => ({ id, deletedAt })),
    );
}

export async function readGenerationLogDeletions(kind: GenerationLogKind) {
    const items: SyncDeletedItem[] = [];
    await stores[kind].iterate<SyncDeletedItem, void>((value) => {
        if (value?.id && value.deletedAt) items.push(value);
    });
    return items;
}

export async function isGenerationLogDeleted(kind: GenerationLogKind, id: string) {
    return Boolean(await stores[kind].getItem<SyncDeletedItem>(id));
}

export async function mergeGenerationLogDeletions(kind: GenerationLogKind, items: SyncDeletedItem[]) {
    const store = stores[kind];
    await Promise.all(
        items.map(async (item) => {
            if (!item.id || !item.deletedAt) return;
            const current = await store.getItem<SyncDeletedItem>(item.id);
            if (!current || item.deletedAt >= current.deletedAt) await store.setItem(item.id, item);
        }),
    );
}
