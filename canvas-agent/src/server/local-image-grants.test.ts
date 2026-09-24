import assert from "node:assert/strict";
import test from "node:test";

import { claimLocalImageGrant, completeLocalImageGrant, isLocalImagePath, localImageGrantKey, localImageGrantScope, registerLocalImageGrants, releaseLocalImageGrant, type LocalImageGrant } from "./local-image-grants.js";

const scope = { clientId: "client-1", threadId: "thread-1", turnId: "turn-1", itemId: "item-1" };
const imagePath = process.platform === "win32" ? String.raw`C:\output\render.png` : "/tmp/render.png";
const secondImagePath = process.platform === "win32" ? String.raw`C:\output\second.webp` : "/tmp/second.webp";

function completedEvent(savedPath: unknown, overrides: Record<string, unknown> = {}) {
    return {
        agent: "codex",
        type: "item.completed",
        sourceClientId: scope.clientId,
        threadId: scope.threadId,
        turnId: scope.turnId,
        item: { id: scope.itemId, type: "image_generation", status: "completed", savedPath },
        ...overrides,
    };
}

test("只为 Codex 成功生图事件注册带作用域的绝对图片路径", () => {
    const grants = new Map<string, LocalImageGrant>();
    registerLocalImageGrants(grants, "agent_event", completedEvent([imagePath, { nested: secondImagePath }, "relative.png", "/tmp/file.svg"]), scope, 1000);
    assert.equal(grants.size, 2);
    assert.equal(claimLocalImageGrant(grants, localImageGrantKey(scope, imagePath), 1001)?.filePath, imagePath);
    for (const otherScope of [
        { ...scope, clientId: "other" },
        { ...scope, threadId: "other" },
        { ...scope, turnId: "other" },
        { ...scope, itemId: "other" },
    ]) assert.equal(claimLocalImageGrant(grants, localImageGrantKey(otherScope, secondImagePath), 1001), undefined);
});

test("拒绝非 Codex、失败、重放或缺少完整作用域的事件", () => {
    const invalidEvents = [
        completedEvent(imagePath, { agent: "claude" }),
        completedEvent(imagePath, { replayed: true }),
        completedEvent(imagePath, { item: { id: scope.itemId, type: "image_generation", savedPath: imagePath, success: false } }),
        completedEvent(imagePath, { item: { id: scope.itemId, type: "image_generation", savedPath: imagePath, error: { message: "failed" } } }),
        completedEvent(imagePath, { item: { id: scope.itemId, type: "image_generation", savedPath: imagePath, status: "error" } }),
        completedEvent(imagePath, { item: { id: scope.itemId, type: "imageGeneration", savedPath: imagePath } }),
    ];
    for (const event of invalidEvents) {
        const grants = new Map<string, LocalImageGrant>();
        registerLocalImageGrants(grants, "agent_event", event, scope, 1000);
        assert.equal(grants.size, 0);
    }
    const grants = new Map<string, LocalImageGrant>();
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), { clientId: "", threadId: scope.threadId, turnId: scope.turnId }, 1000);
    assert.equal(grants.size, 0);
});

test("领取期间拒绝并发读取，失败释放后可重试，成功后不可再次领取", () => {
    const grants = new Map<string, LocalImageGrant>();
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), scope, 1000);
    const key = localImageGrantKey(scope, imagePath);
    assert.ok(claimLocalImageGrant(grants, key, 1001));
    assert.equal(claimLocalImageGrant(grants, key, 1002), undefined);
    const first = grants.get(key)!;
    releaseLocalImageGrant(grants, key, first);
    const retried = claimLocalImageGrant(grants, key, 1003)!;
    completeLocalImageGrant(grants, key, retried);
    assert.equal(claimLocalImageGrant(grants, key, 1004), undefined);
});

test("授权过期后不可领取", () => {
    const grants = new Map<string, LocalImageGrant>();
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), scope, 1000);
    assert.equal(claimLocalImageGrant(grants, localImageGrantKey(scope, imagePath), 15 * 60_000 + 1000), undefined);
});

test("旧请求不能释放或删除重复事件写入的新授权", () => {
    const grants = new Map<string, LocalImageGrant>();
    const key = localImageGrantKey(scope, imagePath);
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), scope, 1000);
    const oldGrant = claimLocalImageGrant(grants, key, 1001)!;
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), scope, 1002);
    const newGrant = grants.get(key)!;
    releaseLocalImageGrant(grants, key, oldGrant);
    completeLocalImageGrant(grants, key, oldGrant);
    assert.equal(grants.get(key), newGrant);
    assert.ok(claimLocalImageGrant(grants, key, 1003));
});

test("领取保持到授权到期，期间不可自动复领", () => {
    const grants = new Map<string, LocalImageGrant>();
    const key = localImageGrantKey(scope, imagePath);
    registerLocalImageGrants(grants, "agent_event", completedEvent(imagePath), scope, 1000);
    const claim = claimLocalImageGrant(grants, key, 1001)!;
    assert.equal(claim.claimedUntil, 15 * 60_000 + 1000);
    assert.equal(claimLocalImageGrant(grants, key, 2 * 60_000 + 1002), undefined);
    assert.equal(claimLocalImageGrant(grants, key, 15 * 60_000 + 1000), undefined);
});

test("单个生图条目只按遍历顺序授权前八个图片路径", () => {
    const grants = new Map<string, LocalImageGrant>();
    const paths = Array.from({ length: 10 }, (_, index) => process.platform === "win32" ? `C:\\output\\render-${index}.png` : `/tmp/render-${index}.png`);
    registerLocalImageGrants(grants, "agent_event", completedEvent(paths), scope, 1000);
    assert.deepEqual([...grants.values()].map((grant) => grant.filePath), paths.slice(0, 8));
    assert.equal(claimLocalImageGrant(grants, localImageGrantKey(scope, paths[8]), 1001), undefined);
});

test("Windows 路径键统一分隔符但保留大小写", { skip: process.platform !== "win32" }, () => {
    assert.equal(
        localImageGrantKey(scope, String.raw`C:\output\render.png`),
        localImageGrantKey(scope, "C:/output/render.png"),
    );
    assert.notEqual(localImageGrantKey(scope, String.raw`C:\Output\render.png`), localImageGrantKey(scope, String.raw`C:\output\render.png`));
});

test("Windows 只接受本机文件、UNC 和受支持的扩展路径", { skip: process.platform !== "win32" }, () => {
    assert.equal(isLocalImagePath(String.raw`C:\output\render.png`), true);
    assert.equal(isLocalImagePath(String.raw`\\server\share\render.webp`), true);
    assert.equal(isLocalImagePath(String.raw`\\?\C:\output\render.png`), true);
    assert.equal(isLocalImagePath(String.raw`\\?\UNC\server\share\render.png`), true);
    assert.equal(isLocalImagePath(String.raw`C:output\render.png`), false);
    assert.equal(isLocalImagePath(String.raw`\output\render.png`), false);
    assert.equal(isLocalImagePath("/output/render.png"), false);
    assert.equal(isLocalImagePath(String.raw`\\.\C:\output\render.png`), false);
    assert.equal(isLocalImagePath(String.raw`C:\output\render.png:stream.png`), false);
});

test("请求作用域必须包含 client、thread、turn 和 item", () => {
    assert.deepEqual(localImageGrantScope(scope), scope);
    assert.equal(localImageGrantScope({ ...scope, itemId: "" }), null);
    assert.equal(localImageGrantScope(null), null);
});
