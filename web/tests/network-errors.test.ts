import "./setup";
import { afterEach, expect, test } from "bun:test";

import { classifyNetworkFailure, isCrossOriginUrl, isOriginNotAllowedFetchResponse, isOriginNotAllowedResponse } from "../src/lib/network-errors";
import { buildApiUrl, useConfigStore } from "../src/stores/use-config-store";

const originalConfig = useConfigStore.getState().config;
const proxyUrl = "http://127.0.0.1:23210";
const targetUrl = "https://provider.example/images";
const requestUrl = `${proxyUrl}/${targetUrl}`;

afterEach(() => useConfigStore.setState({ config: originalConfig }));

test("a different website domain keeps direct API routing and does not imply a CORS failure", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("https://canvas.example.test/") } });
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: false } });
    try {
        const url = buildApiUrl("https://provider.example/root?tenant=site", "/images/generations");
        expect(url).toBe("https://provider.example/root/v1/images/generations?tenant=site");
        expect(isCrossOriginUrl(url)).toBe(true);
        expect(classifyNetworkFailure(new TypeError("Failed to fetch"), url)).toBe("network");
        expect(classifyNetworkFailure(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }), url)).toBe("network");
        expect(classifyNetworkFailure(new TypeError("Failed to fetch: CORS policy blocked access"), url)).toBe("cors");
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
    }
});

test("only actual proxy requests classify an origin refusal as a proxy error", async () => {
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: true, proxyUrl } });
    const refused = { status: 403, data: { error: "origin not allowed" } };
    expect(isOriginNotAllowedResponse(refused, targetUrl)).toBe(false);
    expect(isOriginNotAllowedResponse(refused, requestUrl)).toBe(false);
    expect(isOriginNotAllowedResponse({ status: 200, data: refused.data }, requestUrl)).toBe(false);
    expect(isOriginNotAllowedResponse({ status: 403, data: { error: "invalid API key" } }, requestUrl)).toBe(false);

    const upstream = new Response(JSON.stringify(refused.data), { status: 403 });
    expect(await isOriginNotAllowedFetchResponse(upstream, targetUrl)).toBe(false);
    expect(await isOriginNotAllowedFetchResponse(upstream, requestUrl)).toBe(false);
    expect(await upstream.json()).toEqual(refused.data);
    expect(isOriginNotAllowedResponse({ status: 403, headers: { "x-canvas-proxy-error": "origin-not-allowed" } }, requestUrl)).toBe(true);

    const marked = new Response("", { status: 403, headers: { "x-canvas-proxy-error": "origin-not-allowed" } });
    expect(await isOriginNotAllowedFetchResponse(marked, targetUrl)).toBe(false);
    expect(await isOriginNotAllowedFetchResponse(marked, requestUrl)).toBe(true);
    expect(await isOriginNotAllowedFetchResponse(new Response("forbidden", { status: 403 }), requestUrl)).toBe(false);
    expect(await isOriginNotAllowedFetchResponse(new Response("origin not allowed", { status: 500 }), requestUrl)).toBe(false);
});

test("an unmarked upstream error stream is returned without waiting for its body", async () => {
    useConfigStore.setState({ config: { ...originalConfig, proxyEnabled: true, proxyUrl } });
    const response = new Response(new ReadableStream(), { status: 403 });
    try {
        expect(await isOriginNotAllowedFetchResponse(response, requestUrl)).toBe(false);
        expect(response.bodyUsed).toBe(false);
    } finally {
        await response.body?.cancel();
    }
}, 1000);
