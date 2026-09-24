import { expect, test } from "bun:test";

import { generationLogRank, mergeSyncCollection } from "../src/lib/sync-merge";

test("keeps a completed video log over a pending copy with the same creation time", () => {
    const pending = { id: "task", createdAt: 10, status: "pending" };
    const success = { id: "task", createdAt: 10, status: "success" };
    const result = mergeSyncCollection([pending], [success], [], [], "createdAt", generationLogRank);
    expect(result.items).toEqual([success]);
});

test("keeps a deletion tombstone instead of restoring an older remote item", () => {
    const result = mergeSyncCollection([], [{ id: "asset", updatedAt: "2026-01-01T00:00:00.000Z" }], [{ id: "asset", deletedAt: "2026-01-02T00:00:00.000Z" }], [], "updatedAt");
    expect(result.items).toEqual([]);
    expect(result.deleted).toEqual([{ id: "asset", deletedAt: "2026-01-02T00:00:00.000Z" }]);
});

test("allows an item updated after deletion to replace its tombstone", () => {
    const asset = { id: "asset", updatedAt: "2026-01-03T00:00:00.000Z" };
    const result = mergeSyncCollection([asset], [], [{ id: "asset", deletedAt: "2026-01-02T00:00:00.000Z" }], [], "updatedAt");
    expect(result.items).toEqual([asset]);
    expect(result.deleted).toEqual([]);
});
