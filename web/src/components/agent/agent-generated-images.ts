const LOCAL_IMAGE_PATH = /^(?:\/|[a-z]:[\\/]|\\\\).+\.(?:avif|gif|jpe?g|png|webp)$/i;
const MAX_VISITED_VALUES = 1000;
export const GENERATED_IMAGE_LIMIT = 8;
export const GENERATED_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

export function isSuccessfulImageGeneration(item: { error?: unknown; success?: unknown; status?: unknown }) {
    const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
    return !item.error && item.success !== false && (!status || status === "completed");
}

export function generatedImageSources(value: unknown, result = new Set<string>()) {
    const pending = [value];
    const visited = new WeakSet<object>();
    for (let index = 0; pending.length && index < MAX_VISITED_VALUES; index += 1) {
        const current = pending.pop();
        if (typeof current === "string") {
            if (current.startsWith("data:image/") || (LOCAL_IMAGE_PATH.test(current) && !/[\r\n]/.test(current))) result.add(current);
            continue;
        }
        if (!current || typeof current !== "object" || visited.has(current)) continue;
        visited.add(current);
        const children = Array.isArray(current) ? current : Object.values(current);
        const childCount = Math.min(children.length, MAX_VISITED_VALUES - pending.length);
        for (let childIndex = childCount - 1; childIndex >= 0; childIndex -= 1) pending.push(children[childIndex]);
    }
    return result;
}

export function generatedImageFileName(source: string) {
    if (source.startsWith("data:image/")) return undefined;
    return (/^(?:[a-z]:[\\/]|\\\\)/i.test(source) ? source.split(/[\\/]/) : source.split("/")).at(-1) || undefined;
}

export async function importGeneratedImageSources<T, B extends { size: number }>(
    value: unknown,
    read: (source: string) => Promise<B>,
    transform: (blob: B, source: string, index: number) => Promise<T>,
) {
    const sources = Array.from(generatedImageSources(value));
    const items: T[] = [];
    let failed = Math.max(0, sources.length - GENERATED_IMAGE_LIMIT);
    let totalBytes = 0;
    for (const [index, source] of sources.slice(0, GENERATED_IMAGE_LIMIT).entries()) {
        try {
            const blob = await read(source);
            if (!blob.size || blob.size > GENERATED_IMAGE_MAX_BYTES || totalBytes + blob.size > GENERATED_IMAGE_MAX_BYTES) throw new Error("generated image size limit exceeded");
            totalBytes += blob.size;
            items.push(await transform(blob, source, index));
        } catch {
            failed += 1;
        }
    }
    return { items, failed };
}
