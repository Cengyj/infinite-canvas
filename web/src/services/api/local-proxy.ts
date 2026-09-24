import i18n from "@/i18n";
import { LOCAL_PROXY_PACKAGE, normalizeLocalProxyUrl } from "@/stores/use-config-store";

/** The proxy answers its root path with its own identity payload, which doubles as a reachability check. */
export async function testLocalProxy(proxyUrl: string) {
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base) throw new Error(i18n.t("config.proxy.missingUrl"));
    let response: Response;
    let data: { proxy?: string; version?: string; originAllowed?: boolean } | null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        response = await fetch(`${base}/`, { cache: "no-store", signal: controller.signal });
        data = await response.json().catch(() => null);
    } catch {
        throw new Error(i18n.t("config.proxy.unreachable"));
    } finally {
        clearTimeout(timeout);
    }
    // This is an explicit proxy probe, including when proxy forwarding is disabled in settings.
    if ((data?.proxy === LOCAL_PROXY_PACKAGE && data.originAllowed === false) || (response.status === 403 && response.headers.get("x-canvas-proxy-error") === "origin-not-allowed")) throw new Error(i18n.t("config.proxy.originNotAllowed"));
    if (!response.ok || data?.proxy !== LOCAL_PROXY_PACKAGE) throw new Error(i18n.t("config.proxy.unreachable"));
    return `${data.proxy} v${data.version || "?"}`;
}
