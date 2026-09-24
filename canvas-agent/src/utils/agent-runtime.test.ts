import assert from "node:assert/strict";
import test from "node:test";

import { createAgentLogWriter, redactAgentLog } from "./agent-runtime.js";

test("日志脱敏覆盖 Bearer、API key、GitHub key 和 query token", () => {
    assert.equal(redactAgentLog("Bearer abc.def-123=="), "Bearer [REDACTED]");
    assert.equal(redactAgentLog("api_key=secret-value"), "api_key=[REDACTED]");
    assert.equal(redactAgentLog("ghp_abcdefgh123456"), "[REDACTED]");
    assert.equal(redactAgentLog("/events?token=secret-value&x=1"), "/events?token=[REDACTED]&x=1");
});

test("stderr 分块后仍按完整行脱敏", () => {
    const output: string[] = [];
    const writer = createAgentLogWriter((text) => output.push(text));
    writer.write("Authorization: Basic abc");
    writer.write("123\n下一行");
    writer.flush();
    assert.deepEqual(output, ["Authorization: [REDACTED]\n", "下一行"]);
});
