import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../config.js";
import type { CodexSupplementalHistory, CodexSupplementalHistoryItem, CodexSupplementalHistoryTurn } from "./codex-history.js";

type CodexEventHistoryData = { version: 1; items: CodexSupplementalHistoryItem[]; turns: CodexSupplementalHistoryTurn[] };

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const TEMP_FILE_COUNTER = { value: 0 };
const QUARANTINE_COUNTER = { value: 0 };

export const CODEX_EVENT_HISTORY_FILE = path.join(CONFIG_DIR, "codex-event-history.json");

/** 保存 Codex 持久线程投影可能省略的实时完成事件。 */
export class CodexEventHistory {
    private data?: CodexEventHistoryData;
    private loadFailure?: Error;
    private queue: Promise<void> = Promise.resolve();

    constructor(private file = CODEX_EVENT_HISTORY_FILE) {}

    /** 按 threadId、turnId 和 itemId 新增或更新一条补充事件。 */
    record(entry: CodexSupplementalHistoryItem) {
        return this.run(() => this.withFileLock(async () => {
            const data = await this.load(true);
            const nextInput = validateItem(entry, "record entry");
            const index = data.items.findIndex((item) => sameItem(item, nextInput));
            const previous = index >= 0 ? data.items[index] : undefined;
            const nextEntry = normalizeEntry({
                ...nextInput,
                ...(nextInput.sequence === undefined && previous?.sequence !== undefined ? { sequence: previous.sequence } : {}),
                item: mergeRecord(previous?.item, nextInput.item),
            });
            const items = [...data.items];
            if (index >= 0) items[index] = nextEntry;
            else items.push(nextEntry);
            const nextData = { version: 1 as const, items, turns: data.turns };
            await this.save(nextData);
            this.data = nextData;
        }));
    }

    /** 保存 turn 终态，使标准线程历史尚未物化时仍可恢复完整轮次。 */
    recordTurn(entry: CodexSupplementalHistoryTurn) {
        return this.run(() => this.withFileLock(async () => {
            const data = await this.load(true);
            const nextInput = validateTurn(entry, "record turn");
            const index = data.turns.findIndex((turn) => sameTurn(turn, nextInput));
            const previous = index >= 0 ? data.turns[index] : undefined;
            const nextEntry = normalizeTurn({ ...nextInput, turn: mergeRecord(previous?.turn, nextInput.turn) });
            const turns = [...data.turns];
            if (index >= 0) turns[index] = nextEntry;
            else turns.push(nextEntry);
            const nextData = { version: 1 as const, items: data.items, turns };
            await this.save(nextData);
            this.data = nextData;
        }));
    }

    /** 按 item 开始顺序返回指定线程的补充事件。 */
    readThread(threadId: string) {
        return this.run(() => this.withFileLock(async (): Promise<CodexSupplementalHistory> => {
            const data = await this.load(true);
            return {
                items: data.items.filter((item) => item.threadId === threadId).sort(compareEntries).map(cloneEntry),
                turns: data.turns.filter((turn) => turn.threadId === threadId).map(cloneTurn),
            };
        }));
    }

    /** 归档线程后删除其补充事件。 */
    removeThread(threadId: string) {
        return this.run(() => this.withFileLock(async () => {
            const data = await this.load(true);
            const items = data.items.filter((item) => item.threadId !== threadId);
            const turns = data.turns.filter((turn) => turn.threadId !== threadId);
            if (items.length === data.items.length && turns.length === data.turns.length) return;
            const nextData = { version: 1 as const, items, turns };
            await this.save(nextData);
            this.data = nextData;
        }));
    }

    private run<T>(task: () => Promise<T>) {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async withFileLock<T>(task: () => Promise<T>) {
        const lock = await acquireFileLock(this.file);
        try {
            return await task();
        } finally {
            await lock.release();
        }
    }

    private async load(refresh = false) {
        if (this.loadFailure) throw this.loadFailure;
        if (!refresh && this.data) return this.data;
        try {
            const value = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
            const data = parseHistory(value);
            this.data = data;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.data = emptyHistory();
            } else if (error instanceof SyntaxError) {
                throw await this.rejectCorrupt(invalidHistory("invalid JSON"));
            } else if (error instanceof CodexEventHistoryDataError) {
                throw await this.rejectCorrupt(error);
            } else {
                throw error;
            }
        }
        return this.data!;
    }

    private async save(data: CodexEventHistoryData) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${process.pid}.${Date.now()}.${TEMP_FILE_COUNTER.value++}.tmp`;
        const serialized = JSON.stringify(data, null, 2);
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let temporaryCreated = false;
        try {
            handle = await fs.open(temporaryFile, "wx", 0o600);
            temporaryCreated = true;
            await handle.writeFile(serialized, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(temporaryFile, this.file);
            await syncDirectory(path.dirname(this.file));
        } finally {
            await handle?.close().catch(() => undefined);
            if (temporaryCreated) await fs.unlink(temporaryFile).catch(() => undefined);
        }
    }

    private async rejectCorrupt(error: CodexEventHistoryDataError): Promise<never> {
        if (this.loadFailure) throw this.loadFailure;
        let failure: Error;
        try {
            const quarantineFile = await copyToQuarantine(this.file);
            failure = new Error(`${error.message} Original file was preserved; quarantine copy: ${quarantineFile}`, { cause: error });
        } catch (backupError) {
            failure = new Error(`${error.message} Refusing to overwrite existing data; failed to create quarantine backup: ${errorMessage(backupError)}`, { cause: backupError });
        }
        failure.name = "CodexEventHistoryError";
        this.loadFailure = failure;
        throw failure;
    }
}

export const codexEventHistory = new CodexEventHistory();

function emptyHistory(): CodexEventHistoryData {
    return { version: 1, items: [], turns: [] };
}

function parseHistory(value: unknown): CodexEventHistoryData {
    if (!isRecord(value)) throw invalidHistory("root must be an object");
    if (value.version !== 1) throw unsupportedHistoryVersion(value.version);
    if (!Array.isArray(value.items) || !Array.isArray(value.turns)) throw invalidHistory("items/turns must be arrays");
    return {
        version: 1,
        items: value.items.map((entry, index) => validateItem(entry, `items[${index}]`)).map(normalizeEntry),
        turns: value.turns.map((entry, index) => validateTurn(entry, `turns[${index}]`)).map(normalizeTurn),
    };
}

function validateItem(value: unknown, location: string): CodexSupplementalHistoryItem {
    if (!isRecord(value)) throw invalidHistory(`${location} must be an object`);
    if (!nonEmptyString(value.threadId) || !nonEmptyString(value.turnId) || !nonEmptyString(value.itemId)) throw invalidHistory(`${location} has invalid identity fields`);
    const sequence = value.sequence;
    if (sequence !== undefined && (typeof sequence !== "number" || !Number.isFinite(sequence) || !Number.isInteger(sequence))) throw invalidHistory(`${location}.sequence must be an integer`);
    if (!isRecord(value.item)) throw invalidHistory(`${location}.item must be an object`);
    return {
        ...value,
        threadId: value.threadId,
        turnId: value.turnId,
        itemId: value.itemId,
        ...(sequence === undefined ? {} : { sequence }),
        item: structuredClone(value.item),
    };
}

function validateTurn(value: unknown, location: string): CodexSupplementalHistoryTurn {
    if (!isRecord(value)) throw invalidHistory(`${location} must be an object`);
    if (!nonEmptyString(value.threadId) || !nonEmptyString(value.turnId)) throw invalidHistory(`${location} has invalid identity fields`);
    if (!isRecord(value.turn)) throw invalidHistory(`${location}.turn must be an object`);
    return { ...value, threadId: value.threadId, turnId: value.turnId, turn: structuredClone(value.turn) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function sameItem(left: CodexSupplementalHistoryItem, right: CodexSupplementalHistoryItem) {
    return left.threadId === right.threadId && left.turnId === right.turnId && left.itemId === right.itemId;
}

function sameTurn(left: CodexSupplementalHistoryTurn, right: CodexSupplementalHistoryTurn) {
    return left.threadId === right.threadId && left.turnId === right.turnId;
}

function cloneEntry(entry: CodexSupplementalHistoryItem) {
    return structuredClone(entry);
}

function cloneTurn(entry: CodexSupplementalHistoryTurn) {
    return structuredClone(entry);
}

function compareEntries(left: CodexSupplementalHistoryItem, right: CodexSupplementalHistoryItem) {
    if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) return left.sequence - right.sequence;
    if (left.sequence !== undefined) return -1;
    if (right.sequence !== undefined) return 1;
    return 0;
}

function normalizeEntry(entry: CodexSupplementalHistoryItem): CodexSupplementalHistoryItem {
    return {
        ...entry,
        ...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
        item: structuredClone(entry.item),
    };
}

function normalizeTurn(entry: CodexSupplementalHistoryTurn): CodexSupplementalHistoryTurn {
    return { ...entry, turn: structuredClone({ ...entry.turn, id: entry.turnId }) };
}

function mergeRecord(previous: Record<string, unknown> | undefined, next: Record<string, unknown>) {
    if (!previous) return next;
    const merged = { ...previous };
    Object.entries(next).forEach(([key, value]) => {
        if (value !== undefined) merged[key] = value;
    });
    return merged;
}

function unsupportedHistoryVersion(version: unknown) {
    return new CodexEventHistoryDataError(`Unsupported Codex event history version: ${String(version ?? "missing")}. Refusing to overwrite existing data.`);
}

function invalidHistory(reason: string) {
    return new CodexEventHistoryDataError(`Codex event history is invalid (${reason}). Refusing to overwrite existing data.`);
}

class CodexEventHistoryDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CodexEventHistoryDataError";
    }
}

async function acquireFileLock(file: string) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            handle = await fs.open(lockFile, "wx", 0o600);
            await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
            return {
                release: async () => {
                    await handle?.close().catch(() => undefined);
                    await fs.unlink(lockFile).catch((error: unknown) => {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    });
                },
            };
        } catch (error) {
            if (handle) {
                await handle.close().catch(() => undefined);
                await fs.unlink(lockFile).catch(() => undefined);
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (await removeAbandonedLock(lockFile)) continue;
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for Codex event history lock: ${lockFile}`);
            await delay(LOCK_RETRY_MS);
        }
    }
}

async function removeAbandonedLock(lockFile: string) {
    try {
        const stat = await fs.stat(lockFile);
        const owner = JSON.parse(await fs.readFile(lockFile, "utf8")) as unknown;
        const pid = isRecord(owner) && typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : undefined;
        if (pid !== undefined && isProcessRunning(pid)) return false;
        if (pid === undefined && Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
        await fs.unlink(lockFile);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        if (error instanceof SyntaxError) {
            const stat = await fs.stat(lockFile).catch(() => undefined);
            if (!stat || Date.now() - stat.mtimeMs < LOCK_STALE_MS) return !stat;
            await fs.unlink(lockFile);
            return true;
        }
        throw error;
    }
}

function isProcessRunning(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function copyToQuarantine(file: string) {
    const directory = path.dirname(file);
    const base = path.basename(file);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const target = path.join(directory, `${base}.quarantine-${Date.now()}-${process.pid}-${QUARANTINE_COUNTER.value++}`);
        try {
            await fs.copyFile(file, target, fsConstants.COPYFILE_EXCL);
            await fs.chmod(target, 0o600);
            return target;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    throw new Error(`Unable to create a unique quarantine copy for ${file}`);
}

async function syncDirectory(directory: string) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
        handle = await fs.open(directory, "r");
        await handle.sync();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code)) throw error;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
