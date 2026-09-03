export function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

export function normalizeVideoFrameSize(value: string) {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    return ["9:16", "2:3", "3:4"].includes(value) ? "720x1280" : "1280x720";
}

/** Return a canonical width:height ratio for model-call scripts. */
export function normalizeVideoRatio(value: string) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized || normalized === "auto" || normalized === "adaptive") return "";
    const match = normalized.match(/^(\d+)\s*[x:]\s*(\d+)$/);
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return "";
    let a = width;
    let b = height;
    while (b) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return `${width / a}:${height / a}`;
}
