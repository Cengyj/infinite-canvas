import stripAnsi from "strip-ansi";

/** 在写入文件日志或发送到浏览器前清除常见凭据格式。 */
export function redactAgentLog(text: string): string {
    return text
        .replace(/(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;&]+)/gi, "$1[REDACTED]")
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
        .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
        .replace(/((?:api[ _-]*key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]")
        .replace(/([?&](?:token|api[_-]?key|authorization)=)[^&#\s]+/gi, "$1[REDACTED]");
}

/** 跨 stderr 分块按行处理，避免凭据刚好被拆到两个 chunk 时漏脱敏。 */
export function createAgentLogWriter(emit: (text: string) => void, normalize = (text: string) => text) {
    let buffer = "";
    const send = (text: string) => emit(redactAgentLog(normalize(stripAnsi(text))));
    return {
        write(text: string) {
            buffer += text;
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                send(buffer.slice(0, newline + 1));
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf("\n");
            }
        },
        flush() {
            if (buffer) send(buffer);
            buffer = "";
        },
        clear() {
            buffer = "";
        },
    };
}
