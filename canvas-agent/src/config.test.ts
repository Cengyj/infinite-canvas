import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_VERSION, writeConfigFile, type CanvasAgentConfig } from "./config.js";

const sample: CanvasAgentConfig = { version: CONFIG_VERSION, url: "http://127.0.0.1:17371", token: "test-token" };

function temporaryConfig() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-config-"));
    return { directory, file: path.join(directory, "canvas-agent.json") };
}

test("配置通过同目录临时文件原子替换且不遗留临时文件", (context) => {
    const { directory, file } = temporaryConfig();
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    writeConfigFile(directory, file, sample);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), sample);
    assert.deepEqual(fs.readdirSync(directory), ["canvas-agent.json"]);
});

test("非法配置拒绝覆盖现有文件", (context) => {
    const { directory, file } = temporaryConfig();
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    writeConfigFile(directory, file, sample);
    const current = fs.readFileSync(file, "utf8");
    assert.throws(() => writeConfigFile(directory, file, { ...sample, version: 2 as 1 }), /Unsupported configuration version/);
    assert.equal(fs.readFileSync(file, "utf8"), current);
});

test("配置版本缺失时拒绝写入", (context) => {
    const { directory, file } = temporaryConfig();
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.throws(() => writeConfigFile(directory, file, { url: sample.url, token: sample.token } as CanvasAgentConfig), /version: missing/);
    assert.equal(fs.existsSync(file), false);
});

test("POSIX 下配置目录和文件使用私有权限", { skip: process.platform === "win32" }, (context) => {
    const { directory, file } = temporaryConfig();
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.chmodSync(directory, 0o755);
    writeConfigFile(directory, file, sample);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
