# @basketikun/canvas-proxy

Infinite Canvas 的本地转发代理。浏览器直连第三方 AI 接口时经常被 CORS 拦截，启动它之后，网页会把请求先发到本机，再由本机转发到目标地址。

代理只做转发：不改写请求体，不校验 API Key，不落盘任何日志。

## 使用

```bash
npx @basketikun/canvas-proxy@latest
```

默认监听 `http://127.0.0.1:23210`。把这个地址填进本机运行的 Infinite Canvas「配置 → 本地代理」，并打开开关即可。

代理默认接受没有 `Origin` 的 CLI / 原生客户端，以及来自任意合法 HTTP(S) Origin 的浏览器页面。这样在 `https://canvas.best` 等托管页面之间切换时不会因为来源变化而被代理拦截，行为与 0.1.0 一致。

如果你需要把非本机访问收紧到一个或多个可信页面，可以显式指定来源（回环地址页面仍始终可用）：

```bash
npx @basketikun/canvas-proxy@latest --allow-origin https://canvas.best
```

除通配符 `*` 外，`--allow-origin` 必须填写完整 Origin（协议、主机和可选端口）；允许多个来源时可重复传入。

也可以显式写出默认的宽松模式：

```bash
npx @basketikun/canvas-proxy@latest --allow-origin "*"
```

默认和通配符模式都会回显浏览器实际 Origin，仍拒绝 `Origin: null`、非法来源，以及带浏览器来源标记却缺少 `Origin` 的请求。显式来源模式会对未命中的合法来源返回可读的拒绝诊断，不转发请求。

带上 `@latest` 是因为 npx 会缓存已下载的版本，不加就可能一直运行旧版本。

可选参数：

```bash
npx @basketikun/canvas-proxy@latest --port 23210 --host 127.0.0.1 --allow-origin https://canvas.best
```

也支持 `PORT` / `HOST` 环境变量。

## 转发规则

把完整目标地址接在代理地址后面：

```
http://127.0.0.1:23210/https://api.openai.com/v1/models
        └─── 代理地址 ──┘└──────── 目标地址 ────────┘
```

目标地址的路径、百分号编码和查询参数保持原样，不额外解码，避免破坏签名下载地址和 WebDAV 文件名。请求方法、请求体及业务请求头转发到上游；代理会去除 `host`、逐跳头及浏览器来源头，并重建响应的 CORS 头。未授权来源只会收到可读的 `403 origin not allowed` 诊断（含 `x-canvas-proxy-error: origin-not-allowed`），不会触达上游。SSE 流式响应按块透传，不做缓冲。

访问根路径 `/` 会返回代理版本信息，可用于连通性检测，不会记入转发日志；`Origin: null`、非法来源或带浏览器来源标记却缺少 Origin 的请求仍会收到 403，`Origin: null` 会带可读的 `Access-Control-Allow-Origin: null` 诊断头。

## 转发日志

每转发一条请求就在终端打印一行，包含时间、方法、完整目标地址、上游状态码和耗时：

```
4:05:42 PM GET https://api.openai.com/v1/models -> 200 0.9s
4:05:43 PM POST https://api.openai.com/v1/images/generations -> 200 26.4s
4:05:45 PM GET https://api.example.com/v1/models -> failed (fetch failed) 1.6s
```

日志在收到上游响应头时打印，所以流式请求会立刻出现一行，而不是等整段响应结束。日志只输出到终端，不落盘，也不包含请求头和请求体；URL 中常见的 key、token、签名等敏感查询参数会脱敏。

## 安全提示

代理默认只监听 `127.0.0.1`，默认宽松模式允许本机浏览器打开的任意合法 HTTP(S) 页面通过它访问网络。其他页面不会因此获得画布站点存储的 API Key，但可以自行构造转发请求。如果只信任固定页面，可使用一个或多个精确 `--allow-origin`；不要把代理用 `--host 0.0.0.0` 暴露到公网。API Key 由发起请求的页面提供，代理本身不存储。

## 环境要求

Node.js >= 18。
