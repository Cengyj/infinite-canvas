import { clampVideoSeconds, computeVideoSize, parseVideoResolution } from "@/lib/media-size";

export const VIDEO_POLL_INTERVAL_MS = 3000;
export const VIDEO_POLL_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_VIDEO_REFERENCE_IMAGES = 7;

export function isGrokVideoModel(model: string) {
    return /^grok-imagine-video(?:$|-)/i.test(String(model || "").split("::").pop()!.trim());
}

export function normalizeVideoSeconds(value: string, model = "") {
    if (!isGrokVideoModel(model)) return clampVideoSeconds(value);
    return String(Math.max(1, Math.min(15, Math.floor(Number(value) || 6))));
}
export const normalizeVideoResolution = parseVideoResolution;

export function normalizeVideoFrameSize(value: string, resolution = "720") {
    if (!value || value === "auto") return "auto";
    if (/^\d+x\d+$/i.test(value)) return value.toLowerCase();
    return computeVideoSize(resolution, normalizeVideoRatio(value) || "16:9");
}

export function normalizeVideoResolutionName(value: string) {
    return `${normalizeVideoResolution(value)}p`;
}

/** Preserve the requested orientation and exact ratio for model scripts and results. */
export function normalizeVideoRatio(value: string) {
    const match = String(value || "").trim().match(/^(\d+)\s*[x:]\s*(\d+)$/i);
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return "";
    let a = width;
    let b = height;
    while (b) [a, b] = [b, a % b];
    return `${width / a}:${height / a}`;
}
