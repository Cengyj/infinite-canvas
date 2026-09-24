import "./setup";
import { afterEach, expect, spyOn, test } from "bun:test";

import i18n from "../src/i18n";
import { fetchLatestRelease, fetchLatestVersion } from "../src/services/api/version-check";
import { useConfigStore } from "../src/stores/use-config-store";

const originalConfig = useConfigStore.getState().config;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const proxyUrl = "http://127.0.0.1:23210";

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    useConfigStore.setState({ config: originalConfig });
});

test("release checks request both files through the configured proxy", async () => {
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: true, proxyUrl } });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(String(input).endsWith("/VERSION") ? "v0.19.0" : "# CHANGELOG"));
    expect(await fetchLatestRelease()).toEqual({ version: "v0.19.0", changelog: "# CHANGELOG" });
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls.every(([input, init]) => String(input).startsWith(`${proxyUrl}/https://`) && init?.signal instanceof AbortSignal)).toBe(true);
});

test("release errors distinguish proxy refusal, proxy connection failure, and direct HTTP failure", async () => {
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: true, proxyUrl } });
    const fetchMock = spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403, headers: { "x-canvas-proxy-error": "origin-not-allowed" } }));
    await expect(fetchLatestVersion()).rejects.toThrow(i18n.t("config.proxy.originNotAllowed"));
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchLatestVersion()).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: false } });
    fetchMock.mockResolvedValueOnce(new Response("origin not allowed", { status: 403 }));
    await expect(fetchLatestVersion()).rejects.toThrow(i18n.t("version.readFailed"));
});

test("release timeout also aborts a response whose body stops arriving", async () => {
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => originalSetTimeout(callback, 5)) as typeof setTimeout);
    let signal: AbortSignal | undefined;
    spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        signal = init?.signal || undefined;
        return new Response(new ReadableStream({
            start(controller) {
                signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
            },
        }));
    });
    await expect(fetchLatestVersion()).rejects.toThrow(i18n.t("version.readFailed"));
    expect(signal?.aborted).toBe(true);
});
