import { isLocalProxyUrl, normalizeProxyTargetUrl } from "@/stores/use-config-store";

export type NetworkFailureKind = "cors" | "proxy" | "network" | "other";

/** Browser fetch/XHR errors do not expose the upstream response when CORS blocks them. */
export function isBrowserNetworkError(error: unknown) {
    if (!error) return false;
    const message = error instanceof Error
        ? error.message
        : typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
            ? String((error as { message: string }).message)
            : String(error);
    if (typeof error === "object") {
        const code = (error as { code?: unknown }).code;
        if (code === "ERR_NETWORK") return true;
    }
    return /failed to fetch|networkerror|network request failed|load failed/i.test(message);
}

export function isAbortError(error: unknown) {
    return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");
}

export function isCrossOriginUrl(value: string) {
    if (typeof window === "undefined" || !value) return false;
    try {
        const target = new URL(normalizeProxyTargetUrl(value), window.location.href);
        return /^https?:$/i.test(target.protocol) && target.origin !== window.location.origin;
    } catch {
        return false;
    }
}

function hasExplicitCorsSignal(error: unknown) {
    const value = error instanceof Error
        ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`
        : typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
            ? String((error as { message: string }).message)
            : String(error || "");
    return /\b(?:cors|cross[-\s]?origin|access[-\s]?control[-\s]?allow[-\s]?origin)\b/i.test(value);
}

export function classifyNetworkFailure(error: unknown, requestUrl: string): NetworkFailureKind {
    if (!isBrowserNetworkError(error)) return "other";
    if (isLocalProxyUrl(requestUrl)) return "proxy";
    // Browsers commonly report DNS, TLS, offline, and CORS failures as the same
    // `Failed to fetch`/ERR_NETWORK error. Only call it CORS when the error
    // itself exposes an explicit CORS signal; otherwise keep the neutral class.
    if (isCrossOriginUrl(requestUrl) && hasExplicitCorsSignal(error)) return "cors";
    return "network";
}

export function networkFailureMessage(error: unknown, requestUrl: string, messages: { cors: string; proxy: string; fallback: string }) {
    const kind = classifyNetworkFailure(error, requestUrl);
    return kind === "cors" ? messages.cors : kind === "proxy" ? messages.proxy : messages.fallback;
}

/** Only the proxy's own diagnostic header identifies an origin refusal; upstream error text does not. */
export function isOriginNotAllowedResponse(response: unknown, requestUrl: string) {
    if (!isLocalProxyUrl(requestUrl) || !response || typeof response !== "object") return false;
    const value = response as { headers?: unknown; status?: number };
    if (value.status !== 403) return false;
    const headers = value.headers;
    if (headers && typeof headers === "object") {
        const getHeader = typeof (headers as { get?: unknown }).get === "function"
            ? (headers as { get: (name: string) => string | null }).get.bind(headers)
            : (name: string) => {
                const entries = Object.entries(headers as Record<string, unknown>);
                const entry = entries.find(([key]) => key.toLowerCase() === name);
                return entry && typeof entry[1] === "string" ? entry[1] : null;
            };
        const marker = getHeader("x-canvas-proxy-error");
        if (marker === "origin-not-allowed") return true;
    }
    return false;
}

/** Preserve the async fetch helper contract without reading or buffering an upstream error body. */
export async function isOriginNotAllowedFetchResponse(response: Response, requestUrl: string) {
    return isOriginNotAllowedResponse(response, requestUrl);
}
