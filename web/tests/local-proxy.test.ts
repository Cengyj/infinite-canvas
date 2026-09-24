import "./setup";
import { afterEach, expect, spyOn, test } from "bun:test";

import i18n from "../src/i18n";
import { testLocalProxy } from "../src/services/api/local-proxy";
import { LOCAL_PROXY_PACKAGE } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("proxy probes require a successful proxy identity and evidence of origin rejection", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(Response.json({ proxy: LOCAL_PROXY_PACKAGE, version: "0.1.1" }));
    expect(await testLocalProxy("127.0.0.1:23210")).toBe(`${LOCAL_PROXY_PACKAGE} v0.1.1`);

    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    fetchMock.mockResolvedValueOnce(Response.json({ proxy: "some-other-service" }));
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    fetchMock.mockResolvedValueOnce(Response.json({ proxy: LOCAL_PROXY_PACKAGE }, { status: 502 }));
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    fetchMock.mockResolvedValueOnce(Response.json({ error: "origin not allowed" }, { status: 403 }));
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    fetchMock.mockResolvedValueOnce(Response.json({ proxy: "some-other-service", originAllowed: false }));
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));

    for (const response of [
        Response.json({ proxy: LOCAL_PROXY_PACKAGE, originAllowed: false }),
        new Response("", { status: 403, headers: { "x-canvas-proxy-error": "origin-not-allowed" } }),
    ]) {
        fetchMock.mockResolvedValueOnce(response);
        await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.originNotAllowed"));
    }
});

test("proxy probe timeout remains active until the response body finishes", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_input, init) => {
        signal = init?.signal || undefined;
        return new Response(new ReadableStream({
            start(controller) {
                signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
            },
        }));
    });
    await expect(testLocalProxy("127.0.0.1:23210")).rejects.toThrow(i18n.t("config.proxy.unreachable"));
    expect(signal?.aborted).toBe(true);
}, 7_000);
