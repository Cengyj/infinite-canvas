export type SyncDeletedItem = { id: string; deletedAt: string };

type SyncItem = { id?: string };

export function mergeSyncCollection<T extends SyncItem>(
    localItems: T[],
    remoteItems: T[],
    localDeleted: SyncDeletedItem[],
    remoteDeleted: SyncDeletedItem[],
    timeKey: keyof T,
    rank: (item: T) => number = () => 0,
) {
    const deletedAtById = new Map<string, string>();
    for (const item of [...remoteDeleted, ...localDeleted]) {
        if (!item.id || !item.deletedAt) continue;
        const current = deletedAtById.get(item.id);
        if (!current || item.deletedAt >= current) deletedAtById.set(item.id, item.deletedAt);
    }

    const items = new Map<string, T>();
    for (const item of [...remoteItems, ...localItems]) {
        const id = item.id || "";
        if (!id) continue;
        const current = items.get(id);
        if (!current || compareSyncItems(item, current, timeKey, rank) >= 0) items.set(id, item);
    }

    const merged = Array.from(items.values()).filter((item) => {
        const id = item.id || "";
        const deletedAt = deletedAtById.get(id);
        if (!deletedAt) return true;
        if (syncTime(item[timeKey]) > syncTime(deletedAt)) {
            deletedAtById.delete(id);
            return true;
        }
        return false;
    });

    return {
        items: merged.sort((a, b) => syncTime(b[timeKey]) - syncTime(a[timeKey])),
        deleted: [...deletedAtById.entries()].map(([id, deletedAt]) => ({ id, deletedAt })),
    };
}

export function generationLogRank(item: Record<string, unknown>) {
    if (item.status === "success") return 2;
    if (item.status === "failed") return 1;
    return 0;
}

export function newerSyncItem<T extends SyncItem>(current: T | null, incoming: T, timeKey: keyof T, rank: (item: T) => number = () => 0) {
    return current && compareSyncItems(current, incoming, timeKey, rank) > 0 ? current : incoming;
}

function compareSyncItems<T>(left: T, right: T, timeKey: keyof T, rank: (item: T) => number) {
    const timeDifference = syncTime(left[timeKey]) - syncTime(right[timeKey]);
    return timeDifference || rank(left) - rank(right);
}

function syncTime(value: unknown) {
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value) || 0;
    return 0;
}
