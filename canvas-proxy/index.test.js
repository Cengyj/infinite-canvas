import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";

import { createProxyServer, redactTarget } from "./index.js";

test("explicit origin policy allows local and configured clients but rejects untrusted browsers", async (context) => {
    let hits = 0;
    const upstream = createServer((_req, res) => {
        hits += 1;
        res.setHeader("content-type", "application/json");
        res.setHeader("x-canvas-proxy-error", "upstream-value");
        res.end('{"ok":true}');
    });
    const proxy = createProxyServer({ allowedOrigins: ["https://canvas.best"] });
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, proxy);
    const target = `${proxyUrl}/${upstreamUrl}/private`;

    assert.equal((await fetch(target)).status, 200);
    const local = await fetch(target, { headers: { origin: "http://127.0.0.1:3000" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
    assert.equal(local.headers.get("x-canvas-proxy-error"), null);
    const configured = await fetch(target, { headers: { origin: "https://canvas.best" } });
    assert.equal(configured.status, 200);
    assert.equal(configured.headers.get("access-control-allow-origin"), "https://canvas.best");

    const rejected = await fetch(target, { headers: { origin: "https://attacker.example" } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), "https://attacker.example");
    assert.equal(rejected.headers.get("x-canvas-proxy-error"), "origin-not-allowed");
    assert.deepEqual(await rejected.json(), { error: "origin not allowed" });
    assert.equal((await fetch(target, { headers: { origin: "null" } })).status, 403);
    assert.equal((await fetch(target, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    const rootDiagnostic = await fetch(`${proxyUrl}/`, { headers: { origin: "https://attacker.example" } });
    assert.equal(rootDiagnostic.status, 200);
    assert.equal(rootDiagnostic.headers.get("access-control-allow-origin"), "https://attacker.example");
    assert.equal((await rootDiagnostic.json()).originAllowed, false);
    assert.equal(hits, 3);
});

test("default origin mode accepts valid browser origins without an allow-list", async (context) => {
    let hits = 0;
    const upstream = createServer((_req, res) => {
        hits += 1;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
    });
    const proxy = createProxyServer();
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, proxy);
    const target = `${proxyUrl}/${upstreamUrl}/private`;

    const hosted = await fetch(target, { headers: { origin: "https://hosted.canvas.example" } });
    assert.equal(hosted.status, 200);
    assert.equal(hosted.headers.get("access-control-allow-origin"), "https://hosted.canvas.example");
    assert.deepEqual(await hosted.json(), { ok: true });

    const secondHosted = await fetch(target, { headers: { origin: "http://another.example:5173" } });
    assert.equal(secondHosted.status, 200);
    assert.equal(secondHosted.headers.get("access-control-allow-origin"), "http://another.example:5173");
    assert.equal(hits, 2);
});

test("explicit wildcard origin mode reflects valid origins but still rejects null origins", async (context) => {
    let hits = 0;
    const upstream = createServer((_req, res) => {
        hits += 1;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
    });
    const proxy = createProxyServer({ allowedOrigins: ["*"] });
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, proxy);
    const target = `${proxyUrl}/${upstreamUrl}/private`;

    const reflected = await fetch(target, { headers: { origin: "https://any-site.example" } });
    assert.equal(reflected.status, 200);
    assert.equal(reflected.headers.get("access-control-allow-origin"), "https://any-site.example");
    assert.deepEqual(await reflected.json(), { ok: true });

    const nullOrigin = await fetch(target, { headers: { origin: "null" } });
    assert.equal(nullOrigin.status, 403);
    assert.equal(nullOrigin.headers.get("access-control-allow-origin"), "null");
    assert.equal(nullOrigin.headers.get("x-canvas-proxy-error"), "origin-not-allowed");

    const invalidOrigin = await fetch(target, { headers: { origin: "file://local/app.html" } });
    assert.equal(invalidOrigin.status, 403);
    assert.equal(invalidOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal(invalidOrigin.headers.get("x-canvas-proxy-error"), "origin-not-allowed");
    assert.equal(hits, 1);

    const rootNullOrigin = await fetch(`${proxyUrl}/`, { headers: { origin: "null" } });
    assert.equal(rootNullOrigin.status, 403);
    assert.equal(rootNullOrigin.headers.get("access-control-allow-origin"), "null");
    assert.equal(rootNullOrigin.headers.get("x-canvas-proxy-error"), "origin-not-allowed");
});

test("preflight reflects the trusted origin and requested WebDAV headers", async (context) => {
    const proxy = createProxyServer();
    const proxyUrl = await listen(context, proxy);
    const response = await fetch(`${proxyUrl}/https://example.com/dav`, {
        method: "OPTIONS",
        headers: {
            origin: "http://localhost:3000",
            "access-control-request-method": "PROPFIND",
            "access-control-request-headers": "authorization, content-type",
        },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(response.headers.get("access-control-allow-methods"), "PROPFIND");
    assert.equal(response.headers.get("access-control-allow-headers"), "authorization, content-type");
});

test("forwarding preserves encoded paths and signed query values", async (context) => {
    const upstream = createServer((req, res) => res.end(req.url));
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, createProxyServer());
    const path = "/files/literal%252Fname/%41.png?signature=a%252Fb%2Bc%3D&name=%41&name=two+words";

    const response = await fetch(`${proxyUrl}/${upstreamUrl}${path}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), path);
});

test("chunked POST preserves the request body and provider headers", async (context) => {
    const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, createProxyServer());
    const body = Buffer.from(JSON.stringify({ prompt: "图片", size: "1024x1024", n: 2 }));
    const response = await new Promise((resolve, reject) => {
        const req = request(`${proxyUrl}/${upstreamUrl}/generate`, {
            method: "POST",
            headers: {
                origin: "https://canvas.example",
                "transfer-encoding": "chunked",
                "content-type": "application/json",
                authorization: "Bearer test-token",
                "x-goog-api-key": "test-key",
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        req.write(body.subarray(0, 13));
        req.end(body.subarray(13));
    });

    assert.equal(response.status, 200);
    const received = JSON.parse(response.body);
    assert.equal(received.method, "POST");
    assert.equal(received.body, body.toString());
    assert.equal(received.headers["content-type"], "application/json");
    assert.equal(received.headers.authorization, "Bearer test-token");
    assert.equal(received.headers["x-goog-api-key"], "test-key");
    assert.equal(received.headers["transfer-encoding"], undefined);
});

test("upstream origin errors stay provider responses without proxy diagnostic markers", async (context) => {
    const upstream = createServer((req, res) => {
        res.writeHead(403, {
            "content-type": "application/json",
            ...(req.url === "/with-marker" ? { "x-canvas-proxy-error": "origin-not-allowed" } : {}),
        });
        res.end('{"error":"origin not allowed"}');
    });
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, createProxyServer());

    for (const path of ["/without-marker", "/with-marker"]) {
        const response = await fetch(`${proxyUrl}/${upstreamUrl}${path}`, { headers: { origin: "https://canvas.example" } });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("access-control-allow-origin"), "https://canvas.example");
        assert.equal(response.headers.get("x-canvas-proxy-error"), null);
        assert.deepEqual(await response.json(), { error: "origin not allowed" });
    }
});

test("signed URL credentials and user info are redacted from logs", () => {
    const redacted = new URL(redactTarget("https://user:pass@example.com/file?X-Amz-Signature=secret&X-Amz-Credential=credential&X-Amz-Security-Token=token&GoogleAccessId=id&sig=azure&plain=visible#private"));
    assert.equal(redacted.username, "%5Bredacted%5D");
    assert.equal(redacted.password, "%5Bredacted%5D");
    for (const key of ["X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token", "GoogleAccessId", "sig"]) assert.equal(redacted.searchParams.get(key), "[redacted]");
    assert.equal(redacted.searchParams.get("plain"), "visible");
    assert.equal(redacted.hash, "");
});

test("upstream stream errors and downstream aborts close only their request", async (context) => {
    let resolveStreamClosed;
    const streamClosed = new Promise((resolve) => { resolveStreamClosed = resolve; });
    const upstream = createServer((req, res) => {
        if (req.url === "/broken") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("prefix");
            setTimeout(() => res.socket?.destroy(), 10);
            return;
        }
        const timer = setInterval(() => res.write("chunk\n"), 10);
        res.once("close", () => {
            clearInterval(timer);
            resolveStreamClosed();
        });
    });
    const proxy = createProxyServer();
    const upstreamUrl = await listen(context, upstream);
    const proxyUrl = await listen(context, proxy);

    const broken = await fetch(`${proxyUrl}/${upstreamUrl}/broken`);
    await assert.rejects(() => broken.text());

    const controller = new AbortController();
    const streamed = await fetch(`${proxyUrl}/${upstreamUrl}/stream`, { signal: controller.signal });
    await streamed.body.getReader().read();
    controller.abort();
    await Promise.race([streamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream was not closed")), 500))]);
});

async function listen(context, server) {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    context.after(() => new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
    return `http://127.0.0.1:${address.port}`;
}
