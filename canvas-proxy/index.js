#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const pkg = createRequire(import.meta.url)("./package.json");

const WILDCARD_ORIGIN = "*";
const PROXY_ERROR_HEADER = "x-canvas-proxy-error";
/** Headers that describe the hop to this proxy rather than the upstream request. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", PROXY_ERROR_HEADER]);
const SENSITIVE_QUERY_KEYS = new Set(["key", "api_key", "apikey", "token", "access_token", "accesstoken", "auth", "authorization", "signature", "sig", "secret", "password", "credential", "awsaccesskeyid", "googleaccessid", "key-pair-id", "policy"]);
const SENSITIVE_QUERY_PARTS = /(?:^|[-_])(key|token|auth|authorization|signature|sig|secret|password|credential|policy)(?:$|[-_])/i;

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function readTarget(url) {
    const raw = url.slice(1);
    // The client appends the original target URL; decoding changes escaped paths and signed query values.
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    const target = raw.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function corsHeaders(origin, req) {
    const headers = {
        "access-control-allow-methods": String(req?.headers["access-control-request-method"] || "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
        "access-control-allow-headers": String(req?.headers["access-control-request-headers"] || "content-type, authorization"),
        "access-control-expose-headers": "*",
        "access-control-max-age": "86400",
    };
    if (origin) {
        headers["access-control-allow-origin"] = origin;
        headers.vary = "Origin";
    }
    if (req?.headers["access-control-request-private-network"] === "true") headers["access-control-allow-private-network"] = "true";
    return headers;
}

function responseHeaders(upstream, origin, req) {
    const headers = corsHeaders(origin, req);
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = key === "vary" && headers.vary && !/(?:^|,)\s*origin\s*(?:,|$)/i.test(value) ? `${value}, Origin` : value;
    });
    return headers;
}

function sendJson(req, res, status, payload, origin = "", extraHeaders = {}) {
    res.writeHead(status, { ...corsHeaders(origin, req), ...extraHeaders, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt) {
    console.log(`${new Date().toLocaleTimeString()} ${method} ${redactTarget(target)} -> ${outcome} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

function readArgs(args, name) {
    const option = `--${name}`;
    const prefix = `${option}=`;
    return args.flatMap((value, index) => {
        if (value === option && args[index + 1]) return [args[index + 1]];
        if (value.startsWith(prefix)) return [value.slice(prefix.length)];
        return [];
    });
}

export function redactTarget(target) {
    try {
        const url = new URL(target);
        if (url.username) url.username = "[redacted]";
        if (url.password) url.password = "[redacted]";
        for (const key of url.searchParams.keys()) {
            const lowerKey = key.toLowerCase();
            if (SENSITIVE_QUERY_KEYS.has(lowerKey) || SENSITIVE_QUERY_PARTS.test(lowerKey)) url.searchParams.set(key, "[redacted]");
        }
        url.hash = "";
        return url.toString();
    } catch {
        return target;
    }
}

async function forward(req, res, target, origin) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const controller = new AbortController();
    const abortOnClose = () => controller.abort();
    res.once("close", abortOnClose);
    let upstream;
    try {
        upstream = await fetch(target, { method: req.method, headers: requestHeaders(req), body, redirect: "follow", signal: controller.signal });
    } finally {
        res.off("close", abortOnClose);
    }
    // Logged as soon as the status line arrives, so a long SSE stream still shows up immediately.
    res.writeHead(upstream.status, responseHeaders(upstream, origin, req));
    if (!upstream.body) {
        res.end();
        return upstream.status;
    }
    // Streamed so that SSE responses (text generation) reach the browser chunk by chunk.
    const stream = Readable.fromWeb(upstream.body);
    const destroyStream = () => stream.destroy();
    const handleStreamError = () => {
        if (!res.destroyed) res.destroy();
    };
    stream.once("error", handleStreamError);
    res.once("close", destroyStream);
    res.once("error", destroyStream);
    stream.once("close", () => {
        res.off("close", destroyStream);
        res.off("error", destroyStream);
    });
    stream.pipe(res);
    return upstream.status;
}

export function createProxyServer(options = {}) {
    // Keep the standalone proxy permissive by default, matching the original
    // package behavior. Pass one or more `allowedOrigins` entries to opt into
    // an explicit allow-list; `*` remains the explicit wildcard form.
    const configuredOrigins = options.allowedOrigins?.length ? options.allowedOrigins : [WILDCARD_ORIGIN];
    const allowedOrigins = new Set((configuredOrigins || []).map(normalizeAllowedOrigin).filter(Boolean));
    return createServer((req, res) => {
        const target = readTarget(req.url || "/");
        const origin = allowedRequestOrigin(req, allowedOrigins);
        // Keep the health/root probe readable so a hosted page can distinguish an
        // unavailable proxy from a running proxy whose explicit allow-list rejects it.
        if (!target && req.method === "GET") {
            const requestedOrigin = normalizeRequestOrigin(req.headers.origin);
            const invalidBrowserOrigin = origin === null && (req.headers.origin === undefined ? req.headers["sec-fetch-site"] !== undefined : req.headers.origin === "null" || !requestedOrigin);
            if (invalidBrowserOrigin) {
                sendJson(req, res, 403, { error: "origin not allowed" }, requestedOrigin, { [PROXY_ERROR_HEADER]: "origin-not-allowed" });
                return;
            }
            const diagnosticOrigin = origin === null ? requestedOrigin : origin;
            sendJson(req, res, 200, {
                app: "infinite-canvas",
                proxy: pkg.name,
                version: pkg.version,
                usage: "/<full-target-url>",
                originAllowed: origin !== null,
            }, diagnosticOrigin);
            return;
        }
        if (origin === null) {
            // Echo a syntactically valid rejected origin only on this diagnostic
            // response, so the browser can read the reason and suggest the
            // exact --allow-origin flag. No upstream data is exposed.
            sendJson(req, res, 403, { error: "origin not allowed" }, normalizeRequestOrigin(req.headers.origin), { [PROXY_ERROR_HEADER]: "origin-not-allowed" });
            return;
        }
        if (req.method === "OPTIONS" && origin && req.headers["access-control-request-method"]) {
            res.writeHead(204, corsHeaders(origin, req));
            res.end();
            return;
        }
        if (!target) {
            sendJson(req, res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>" }, origin);
            return;
        }
        const startedAt = Date.now();
        const method = req.method || "GET";
        forward(req, res, target, origin)
            .then((status) => logForward(method, target, status, startedAt))
            .catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                logForward(method, target, `failed (${reason})`, startedAt);
                if (res.headersSent || res.destroyed) {
                    if (!res.destroyed) res.destroy();
                    return;
                }
                sendJson(req, res, 502, { error: reason }, origin);
            });
    });
}

function normalizeOrigin(value) {
    try {
        const url = new URL(String(value));
        if (!/^https?:$/.test(url.protocol) || url.origin === "null" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
        return url.origin;
    } catch {
        return "";
    }
}

function normalizeRequestOrigin(value) {
    if (value === "null") return "null";
    return typeof value === "string" ? normalizeOrigin(value) : "";
}

function normalizeAllowedOrigin(value) {
    const raw = String(value).trim();
    return raw === WILDCARD_ORIGIN ? WILDCARD_ORIGIN : normalizeOrigin(raw);
}

function allowedRequestOrigin(req, allowedOrigins) {
    const rawOrigin = req.headers.origin;
    if (rawOrigin === undefined) return req.headers["sec-fetch-site"] === undefined ? "" : null;
    if (Array.isArray(rawOrigin)) return null;
    // `null` is used by file:// pages and sandboxed documents. Keep it
    // rejected even in wildcard mode: it has no trustworthy web origin to
    // display back to the browser and would make the local proxy reachable by
    // arbitrary local files.
    if (rawOrigin === "null") return null;
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) return null;
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || allowedOrigins.has(origin) || allowedOrigins.has(WILDCARD_ORIGIN) ? origin : null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`${pkg.name} v${pkg.version}\n\nUsage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1] [--allow-origin https://canvas.best]\n\nBy default, browser requests from any valid HTTP(S) origin are accepted. Repeat --allow-origin to opt into an exact allow-list; use --allow-origin "*" to state the permissive default explicitly. Origin: null, invalid origins, and browser requests that omit Origin while carrying fetch metadata remain blocked.`);
        process.exit(0);
    }
    const invalidOrigins = readArgs(args, "allow-origin").filter((origin) => !normalizeAllowedOrigin(origin));
    if (invalidOrigins.length) throw new Error(`Invalid --allow-origin value: ${invalidOrigins[0]}`);
    const configuredOrigins = readArgs(args, "allow-origin");
    const allowedOrigins = configuredOrigins.length ? configuredOrigins : undefined;
    const port = Number(readArg(args, "port", process.env.PORT || 23210));
    const host = readArg(args, "host", process.env.HOST || "127.0.0.1");
    createProxyServer({ allowedOrigins }).listen(port, host, () => {
        console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
        console.log(`Fill this address into Infinite Canvas -> 配置 -> 本地代理: http://${host}:${port}`);
    });
}
