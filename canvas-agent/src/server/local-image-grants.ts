import path from "node:path";

export const LOCAL_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

const LOCAL_IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const LOCAL_IMAGE_GRANT_TTL_MS = 15 * 60_000;
const LOCAL_IMAGE_GRANT_LIMIT = 100;
const LOCAL_IMAGE_ITEM_GRANT_LIMIT = 8;
const MAX_SAVED_PATH_VALUES = 1000;

export type LocalImageGrantScope = { clientId: string; threadId: string; turnId: string; itemId: string };
export type LocalImageGrant = { filePath: string; expiresAt: number; claimedUntil?: number };
export type LocalImageGrantEventScope = Omit<LocalImageGrantScope, "itemId">;

export function localImageGrantScope(value: unknown): LocalImageGrantScope | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const scope = {
        clientId: stringField(record.clientId),
        threadId: stringField(record.threadId),
        turnId: stringField(record.turnId),
        itemId: stringField(record.itemId),
    };
    return Object.values(scope).every(Boolean) ? scope : null;
}

export function registerLocalImageGrants(grants: Map<string, LocalImageGrant>, eventType: string, payload: Record<string, unknown>, eventScope: LocalImageGrantEventScope, now = Date.now()) {
    if (eventType !== "agent_event" || payload.agent !== "codex" || payload.replayed || payload.type !== "item.completed" || !payload.item || typeof payload.item !== "object" || Array.isArray(payload.item)) return;
    const item = payload.item as Record<string, unknown>;
    const status = stringField(item.status).toLowerCase();
    if (item.type !== "image_generation" || item.error || item.success === false || (status && status !== "completed")) return;
    const scope = localImageGrantScope({ ...eventScope, itemId: item.id });
    if (!scope) return;
    pruneLocalImageGrants(grants, now);
    for (const filePath of savedImagePaths(item.savedPath)) {
        while (grants.size >= LOCAL_IMAGE_GRANT_LIMIT) grants.delete(grants.keys().next().value as string);
        grants.set(localImageGrantKey(scope, filePath), { filePath, expiresAt: now + LOCAL_IMAGE_GRANT_TTL_MS });
    }
}

export function claimLocalImageGrant(grants: Map<string, LocalImageGrant>, key: string, now = Date.now()) {
    pruneLocalImageGrants(grants, now);
    const grant = grants.get(key);
    if (!grant || grant.claimedUntil) return undefined;
    const claimed = { ...grant, claimedUntil: grant.expiresAt };
    grants.set(key, claimed);
    return claimed;
}

export function releaseLocalImageGrant(grants: Map<string, LocalImageGrant>, key: string, grant: LocalImageGrant) {
    if (grants.get(key) === grant) delete grant.claimedUntil;
}

export function completeLocalImageGrant(grants: Map<string, LocalImageGrant>, key: string, grant: LocalImageGrant) {
    if (grants.get(key) === grant) grants.delete(key);
}

export function localImageGrantKey(scope: LocalImageGrantScope, filePath: string) {
    const normalized = process.platform === "win32" ? path.win32.normalize(filePath) : path.posix.normalize(filePath);
    return JSON.stringify([scope.clientId, scope.threadId, scope.turnId, scope.itemId, normalized]);
}

export function isLocalImagePath(filePath: string) {
    if (!filePath || /[\0\r\n]/.test(filePath) || !LOCAL_IMAGE_EXTENSION.test(filePath)) return false;
    if (process.platform !== "win32") return path.posix.isAbsolute(filePath);
    const normalized = filePath.replace(/\//g, "\\");
    if (normalized.startsWith("\\\\.\\")) return false;
    const drive = /^[a-z]:\\/i.test(normalized);
    const extendedDrive = /^\\\\\?\\[a-z]:\\/i.test(normalized);
    const unc = /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/i.test(normalized);
    const extendedUnc = /^\\\\\?\\unc\\[^\\]+\\[^\\]+/i.test(normalized);
    if (!drive && !extendedDrive && !unc && !extendedUnc) return false;
    const allowedColon = drive ? 1 : extendedDrive ? 5 : -1;
    return ![...normalized].some((character, index) => character === ":" && index !== allowedColon);
}

function pruneLocalImageGrants(grants: Map<string, LocalImageGrant>, now: number) {
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
}

function savedImagePaths(value: unknown) {
    const result = new Set<string>();
    const pending = [value];
    const visited = new WeakSet<object>();
    for (let index = 0; pending.length && index < MAX_SAVED_PATH_VALUES && result.size < LOCAL_IMAGE_ITEM_GRANT_LIMIT; index += 1) {
        const current = pending.pop();
        if (typeof current === "string") {
            if (isLocalImagePath(current)) result.add(current);
            continue;
        }
        if (!current || typeof current !== "object" || visited.has(current)) continue;
        visited.add(current);
        const children = Array.isArray(current) ? current : Object.values(current);
        const childCount = Math.min(children.length, MAX_SAVED_PATH_VALUES - pending.length);
        for (let childIndex = childCount - 1; childIndex >= 0; childIndex -= 1) pending.push(children[childIndex]);
    }
    return result;
}

function stringField(value: unknown) {
    return typeof value === "string" ? value : "";
}
