# OpenCode Bridge

一个本地运行的浏览器扩展（Chrome / Safari，Manifest V3），为静态网页 /
browser coding agent 提供到 OpenCode Console 与 OpenCode Go 推理 API 的薄传输层。

它只做四件事：

1. 在扩展本地保存用户自己的 API key；
2. 校验发起请求的网页 Origin；
3. 用扩展的 host permission 发起 HTTPS 请求；
4. 把普通响应或 SSE 流原样转发给网页。

它**不**修改 prompt、不判断聊天还是写代码、不强制选择 provider、不做自动重试、不做
模型 fallback、不做遥测，也不试图执行 OpenCode 的订阅政策。

---

## 订阅政策说明

本项目是本地传输与凭据桥接层。它不会检查 prompt、不会把流量分类为 “coding” 或
“chat”、不会强制执行 OpenCode 的订阅规则，也不会强制选择某个 provider。provider
由你选择，你是否符合 OpenCode 的条款由你自行判断。

本项目**不会针对 chat-for-code 做拦截或强制跳转到 pay-as-you-go**；如果你选择用
Go 订阅发送这类请求，请自行参照 OpenCode 官方文档和政策权衡。

OpenCode 官方文档说明：OpenCode Go 面向 OpenCode 及其他发送典型 coding agent 流量、
使用自己 User-Agent、并发送稳定 session ID 的 coding agent。OpenCode 可能监控流量
并执行限制。官方文档为准，且可能变化：

- OpenCode Go：<https://opencode.ai/docs/console/go>
- Console API：<https://opencode.ai/docs/console/api>
- Inference API：<https://opencode.ai/docs/console/api/inference>
- Harnesses / Base URLs / Sessions：<https://opencode.ai/docs/console/harnesses>
- Terms：<https://opencode.ai/legal/terms-of-service>

如果你不确定自己的用法是否符合要求，请查阅 OpenCode 官方文档或联系其支持，或使用
Console 按量付费。

本项目与 OpenCode 无隶属关系，不提供或共享 API key，不帮助绕过限制，也不帮助冒充
已验证客户端。

---

## Provider 与端点

| Provider | Base URL |
|---|---|
| `console`（按量付费） | `https://opencode.ai/inference` |
| `go`（Go / Go Plus / Go Teams） | `https://opencode.ai/inference/go` |
| `custom` | 你自己配置的 HTTPS base URL |

| API | Path |
|---|---|
| OpenAI Chat Completions | `/openai/v1/chat/completions` |
| OpenAI Responses | `/openai/v1/responses` |
| Anthropic Messages | `/anthropic/v1/messages` |
| 模型列表 | `/v1/models` |

例如：

```text
Console: https://opencode.ai/inference/openai/v1/chat/completions
Go:      https://opencode.ai/inference/go/openai/v1/chat/completions
```

模型字段使用 API model ID，例如 `kimi-k3`、`gpt-6-luna`、`claude-haiku-5-5`。
`opencode-go/kimi-k3` 是 OpenCode 配置里的写法，不要用在 API 的 `model` 字段里。

官方说明：

- `Authorization: Bearer oc_sk_...`
- `x-opencode-session: ses_...`：Go 要求必须带；Console 也建议带。
- Anthropic Messages 额外发送 `anthropic-version: 2023-06-01`；当前 OpenCode 文档没有把它列为必需，但 Anthropic 兼容客户端通常需要它。
- 每个文本模型都可以通过其他 API 形状调用，由 Console 转换。
- Console 的 free-tier chat models 只允许 OpenCode 内部使用；其他客户端会收到 403。
  请使用 paid models 或 Go。

---

## 安装（加载已解压的扩展）

需要 Chrome 120+（`minimum_chrome_version` 已写入 manifest）。

1. 打开 `chrome://extensions`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目目录。
4. 打开扩展的「扩展程序选项」。

如果通过网页调用，请记录扩展 ID。未打包扩展的 ID 可能随目录变化；需要稳定 ID 时，
在 `manifest.json` 中加入 `key`，或使用 Chrome Web Store 分配的 ID。

---

## 安装（Safari）

需要 Safari 16.4+（完整支持 MV3 service worker；更早版本的 MV3 支持不完整，可能需要
按转换器提示改用非持久 background page）。

1. 用 Apple 官方转换器生成 Xcode 工程：

   ```bash
   xcrun safari-web-extension-converter /path/to/opencodeGoBrigde
   ```

2. 在 Xcode 中选择你的签名 team（免费个人 team 即可），运行一次包含 App。
3. Safari → 设置 → 高级 → 勾选「显示网页开发者功能」。
4. Safari → 开发 → 勾选「允许未签名的扩展」（开发构建每次重开 Safari 后可能需要重勾）。
5. Safari → 设置 → 扩展 → 启用 OpenCode Bridge。
6. 关键：Safari 需要**按站点授权**。打开扩展的 Website Access（Safari → 设置 →
   扩展 → OpenCode Bridge），允许运行 SDK 的站点；本地开发可允许 `localhost`，
   或选择「在所有网站上始终允许」。改完访问权限后**刷新页面**。

Safari 下设置页显示的 Extension ID 是扩展的 **bundle identifier**（例如
`com.example.OpenCodeBridge.Extension`），不是 Chrome 的 32 位 ID；它也不能通过
manifest 的 `key` 固定，ID 由 Xcode 工程里的 bundle identifier 决定。SDK 会优先尝试
直连，失败后自动改用 content script 中继（见下文）。

Safari 没有 `chrome.offscreen`，因此推理请求回退到 Service Worker fetch，受 25 秒
首字节 / 5 分钟单请求计时约束。DNR User-Agent 规则在 Safari 上的支持度取决于版本；
不支持时规则会被跳过，是否实际发送自定义 UA 请以抓包为准。

---

## 配置

### Provider

- `Console pay-as-you-go`：默认，适合通用网页 / 聊天前端。
- `OpenCode Go`：使用 Go 订阅；请自行对照官方客户端要求。
- `Custom HTTPS base URL`：适合自建兼容网关或测试；保存时会申请该 origin 的
  optional host permission。localhost / 私网地址会被拒绝。

### API key

- 只保存在 `chrome.storage.local`。
- 不使用 `chrome.storage.sync`，不会同步到 Google 账号。
- 选项页默认只显示掩码；输入框留空表示保留已保存的 key。
- 网页、SDK、日志、错误信息中都不会出现 key。

### Client User-Agent

Chrome 会静默丢弃 `fetch` 里设置的 `User-Agent`，所以扩展使用
`declarativeNetRequest` 的 `modifyHeaders` 设置它。默认值：

```text
opencode-bridge/0.2.0
```

默认值由 `chrome.runtime.getManifest().version` 生成；升级扩展后，未保存过该设置的
用户会自动使用新版本号，已保存的值不会被覆盖。

如果你在做 browser coding agent，可以改成自己的产品名和版本，例如：

```text
my-browser-coding-agent/1.0
```

请使用诚实的标识；不要冒充 Claude Code、Codex、OpenCode 或其他已验证客户端。

> DNR 的 User-Agent 规则使用 session rule + `requestDomains: [host]` +
> `tabIds: [-1]`。Chrome 文档说明 `tabIds: [-1]`（`TAB_ID_NONE`）匹配“不来自 tab”
> 的请求，因此它作用于发往该 host 的非 tab 请求，包括扩展 Service Worker/offscreen
> 的 fetch；用户自己在 `opencode.ai` 标签页里的请求带 tabId，不会被匹配。
>
> 这不是严格的“只限扩展 initiator”过滤器：规则没有使用 `initiatorDomains`，Chrome
> 文档也没有确认 extension origin 可用于该字段。不同 Chrome 版本的实际行为建议用
> mock server 抓包确认。

### Allowed origins

每行一个精确 Origin，例如：

```text
https://app.example.com
http://localhost:8000
```

规则：

- 默认空列表，任何网页都不能连接。
- 只做精确匹配，不做前缀匹配。
- 必须包含 scheme + host + port；不能带 path / query / hash。
- 非 localhost 的 `http://` 会被拒绝。
- 当前 manifest 使用 `externally_connectable.matches: ["http://*/*", "https://*/*"]`，
  并且对所有 http/https 页面注入了轻量 content script relay。两者都只是“入口”：
  content script 不读 storage、不持有 key、不理解业务，实际访问控制完全依赖这里的
  Origin 白名单，Service Worker 会在直连和 relay 两条路径上做同样的校验。

### Request limits

`Maximum request body (MiB)` 控制桥接接受的 JSON body 上限，默认 32 MiB，可在
1–32 MiB 之间调整。超过上限会返回 `BODY_TOO_LARGE`。这个设置只影响桥接层，不改变
上游的限制。base64 图片约为原始二进制的 1.33 倍，优先使用 HTTPS 图片 URL。

---

## 网页 SDK

SDK 文件：`sdk/opencode-bridge.js`。它是 ES module，并同时把
`OpenCodeBridge` 挂到 `globalThis`。

```html
<script type="module">
  import { OpenCodeBridge } from "/sdk/opencode-bridge.js";

  const bridge = new OpenCodeBridge({
    extensionId: "YOUR_EXTENSION_ID"
  });

  const conversation = bridge.createConversation();

  const stream = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "Give me a small refactor idea." }],
    stream: true
  });

  for await (const chunk of stream) {
    const text = chunk?.choices?.[0]?.delta?.content;
    if (text) console.log(text);
  }
</script>
```

### 传输选择（Chrome / Safari）

SDK 默认 `transport: "auto"`：

1. 先尝试直连（`externally_connectable`，Chrome 的主路径，部分 Safari 版本也可用），
   探针默认 1.5 秒；
2. 直连握手失败时，自动回退到 **content script 中继**：页面用 `window.postMessage`
   与扩展的 content script 通信，content script 再通过内部 runtime port 连接
   Service Worker。Safari 网页走这条路径。

```js
const bridge = new OpenCodeBridge({
  extensionId: "com.example.OpenCodeBridge.Extension", // Safari 下是 bundle ID
  transport: "auto" // "auto" | "direct" | "relay"
});

await bridge.connect();
console.log(bridge.transport); // "direct" 或 "relay"
```

中继路径仍要求页面 Origin 在扩展的 Allowed origins 中；Safari 还要求先在
Website Access 中允许该站点。失败时错误码包括 `CONTENT_SCRIPT_MISSING`（content
script 未注入 / 站点未授权）和 `NO_BRIDGE_TRANSPORT`（既无 runtime 也无法中继）。

### 非流式

```js
const conversation = bridge.createConversation();

const response = await conversation.chat.completions.create({
  model: "kimi-k3",
  messages: [{ role: "user", content: "Say hi." }],
  stream: false
});

console.log(response.status, response.json ?? response.body);
```

### Responses API

```js
const response = await conversation.responses.create({
  model: "gpt-6-luna",
  input: "Say hi.",
  stream: false
});
```

### Anthropic Messages

```js
const stream = await conversation.messages.create({
  model: "claude-haiku-5-5",
  max_tokens: 128,
  messages: [{ role: "user", content: "Say hi." }],
  stream: true
});

for await (const event of stream) {
  // Anthropic 事件原样透传，例如 content_block_delta / message_stop。
  if (event?.type === "content_block_delta") {
    console.log(event.delta?.text);
  }
}
```

传输层不解析 `content` 里的每个 part：字符串和 content-block 数组都原样透传（包括
`image_url`、Anthropic `image`/`source`、Responses `input_image` 等）；桥接不做
OpenAI ↔ Anthropic 转换，也不判断模型是否支持某种模态，这些由 OpenCode Console 和
上游模型决定。`system` 支持字符串或 Anthropic content-block 数组，`tools` 原样透传。
Anthropic 流不以 `[DONE]` 结束，SDK 在流关闭时正常结束迭代。

### 多模态输入

桥接层是 JSON 透传，不解析、不裁剪、不改写 `content` / `input` 里的 part。图片、音频、
PDF 等能否使用由上游模型决定；桥接不做跨 API 的 part 转换，请使用目标端点原生的形状。

Chat Completions（图片 URL）：

```js
await conversation.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "What is in this image?" },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } }
    ]
  }],
  stream: false
});
```

Anthropic Messages（base64 图片）：

```js
await conversation.messages.create({
  model: "claude-haiku-5-5",
  max_tokens: 256,
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
      { type: "text", text: "Describe this." }
    ]
  }],
  stream: false
});
```

Responses（`input_image`）：

```js
await conversation.responses.create({
  model: "gpt-6-luna",
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: "Describe this." },
      { type: "input_image", image_url: "https://example.com/cat.png" }
    ]
  }],
  stream: false
});
```

注意：

- 只支持 JSON；二进制必须 base64 或 URL，不能直接传 `FormData` / Blob。
- 默认请求体上限 32 MiB，可在 options 调整；大图优先用 URL。
- 上游模型不支持该模态时会返回上游错误；桥接不会替你换模型。

### Session ID

`createConversation()` 会生成一个稳定的 `ses_...`，同一 conversation 的所有请求都会
复用它。切换模型、工具调用、重试都保持同一个 ID；新建会话才换新的 ID。

如果你希望跨页面刷新保持同一个 conversation，请自己持久化 session ID：

```js
const conversation = bridge.createConversation({
  sessionId: localStorage.getItem("my-session-id") || undefined
});
localStorage.setItem("my-session-id", conversation.sessionId);
```

### 取消

```js
const controller = new AbortController();
const stream = await conversation.chat.completions.create(body, {
  signal: controller.signal
});

controller.abort();
```

取消会 abort 上游请求；已经生成的部分可能产生费用，不能保证“取消不计费”。

### OpenAI SDK / 自定义 fetch 适配器

```js
const conversation = bridge.createConversation();

const openaiCompatibleFetch = conversation.createFetch({
  // 默认匹配 /chat/completions、/responses 和 /anthropic/v1/messages。
  // 只对 OpenCode 客户端使用时，建议显式限制：
  matchUrl: (url) => url.includes("opencode.ai/inference")
});

const client = new OpenAI({
  apiKey: "unused-the-extension-injects-the-real-key",
  baseURL: "https://opencode.ai/inference/openai/v1",
  fetch: openaiCompatibleFetch
});
```

适配器会忽略页面传入的 `Authorization`，由扩展注入真实 key。它只适合作为
OpenCode 客户端的传输层；不要把它挂到其他 provider 的全局 fetch 上。

---

## Demo

```bash
# 在项目根目录
python3 -m http.server 8000
```

1. 打开 <http://localhost:8000/demo/>。
2. 在扩展选项页的 Allowed origins 中加入 `http://localhost:8000`。
3. 把扩展 ID 填入 demo。
4. 选择模型，发送。

不要用 `file://` 打开 demo；`file://` 的 Origin 是 opaque/`null`，会被拒绝。

---

## 消息协议

网页通过 `chrome.runtime.connect(extensionId, { name: "opencode-bridge" })` 连接。

请求：

```js
{
  type: "request",
  requestId: "req_...",
  api: "chat.completions" | "responses" | "anthropic.messages" | "models.list",
  body: { ... },       // models.list 时为 null
  sessionId: "ses_..." // 可选；扩展会生成
}
```

响应事件：

| type | 含义 |
|---|---|
| `hello` | 扩展已接受连接 |
| `accepted` | 上游返回 2xx，准备转发 |
| `chunk` | SSE 文本块 |
| `response` | 非流式响应体 |
| `done` | 请求完成 |
| `error` | 错误（含 code / status / body） |
| `cancelled` | 已取消 |

取消：

```js
{ type: "cancel", requestId: "req_..." }
```

心跳：

```js
{ type: "ping" }  // 扩展回 { type: "pong" }
```

网页不能传 URL、method、headers、Authorization 或 User-Agent；这些都由扩展控制。

扩展自身页面（options/浏览器测试 harness）可以使用同一个协议，但走内部
`chrome.runtime.onConnect`；Service Worker 只接受 `sender.id` 和
`sender.url` 都属于本扩展的 context。网页仍然走
`onConnectExternal` + Origin 白名单，不会因为内部路径而放宽。

Safari 等无法直连的网页走 content script 中继：页面与 `content/relay.js` 之间使用
`window.postMessage` 信封（`{ __opencodeBridge: 1, kind: "open"|"msg"|"close",
portId, seq, payload }`），relay 再用内部 port 名 `opencode-bridge-relay` 连接
Service Worker。中继不改变上面任何消息语义；Service Worker 对中继 port 同样执行
`validatePortOrigin`（`sender.origin` 必须匹配白名单，且与 `sender.url` 的 origin
一致）。

---

## 安全设计

- **Origin**：`port.sender.origin` 精确匹配白名单；拒绝 `null` / opaque origin。
- **Key**：`storage.local` + `setAccessLevel("TRUSTED_CONTEXTS")`；不使用 sync。
- **请求**：只接受 `api`、`requestId`、`body`、`sessionId`；拒绝任意 URL/header。
- **网络**：`redirect: "error"`；校验最终 `response.url` 的 origin；自定义 base 拒绝私网。
- **限制**：请求体默认 32 MiB（可在 options 调整）；响应/流默认 32 MiB；全局并发 4，
  每 origin 并发 2；超出直接返回错误。`messages` / `content` / `input` 内部是不透明
  JSON，桥接不解析、不裁剪 content part。
- **日志**：不记录 key、prompt、response body；只可能记录非敏感的配置错误。
- **CORS**：扩展后台带 host permission 的 fetch 不走普通网页 CORS；不修改
  `Access-Control-Allow-Origin`，不要求关闭浏览器安全策略。
- **内容脚本**：`content/relay.js` 只做消息转发（`window.postMessage` ↔ 内部 port），
  不读 `storage.local`、不持有 key、不做 Origin 判定；`setAccessLevel("TRUSTED_CONTEXTS")`
  仍然阻止它读取保存的凭据。两条传输路径的访问控制都在 Service Worker。

详见 [SECURITY.md](SECURITY.md)。

---

## 长流与 MV3 生命周期

Chrome 的三个限制需要分开看：

| 限制 | 约束对象 | 本项目处理 |
|---|---|---|
| 30 秒无活动 | Service Worker 整体 | 页面 SDK 每 20 秒 ping；offscreen 每 20 秒 ping；SW alarm 30 秒 |
| 单请求/事件超过 5 分钟 | Service Worker 的单个事件/API 调用 | 网络流不放在 SW，放在 offscreen document；SW 只做短路由 |
| `fetch` 首字节超过 30 秒 | Service Worker 发起的 fetch | 推理请求在 offscreen 中 fetch；首字节最长等 5 分钟 |

也就是说，**5 分钟不是“一个回复只能 5 分钟”的对话级限制，也不是整个 agent 会话的
上限**。一个 code agent 可以跑几十分钟，由多次模型调用组成；每次模型调用是独立请求。
真正需要避免的是让某一次长流依赖 Service Worker 的 request timer。

实现方式：

```text
Page SDK
  -> chrome.runtime port
  -> Service Worker (validation / concurrency / routing)
  -> chrome.runtime port
  -> Offscreen document (long-lived fetch + SSE)
  -> OpenCode API
```

- 推理请求（Chat Completions / Responses）在 offscreen document 中执行；非流式和
  流式都走这里。
- `models.list` 仍由 Service Worker 直接处理。
- offscreen 文档不是 Service Worker，非音频 reason 没有文档化的 request 生命周期
  上限；它通过每 20 秒向 SW 发消息来重置 SW 的 idle timer。
- 如果 offscreen 不可用（权限、创建失败等），会回退到 Service Worker fetch；此时
  回到 25 秒首字节 / 5 分钟 request timer 的旧限制。
- offscreen 使用 `WORKERS` reason（Chrome 没有 network reason）。如果上架 Chrome
  Web Store，需要在审核说明里解释这个用途。
- 一个 profile 只能有一个 offscreen document；它被 Chrome 回收或 SW 重启时，活动流
  会收到 `OFFSCREEN_DISCONNECTED`，不会假装续传。

## 已知限制

1. **长流执行**：推理请求在 offscreen 中执行，首字节最长等 5 分钟，响应/流上限
   32 MiB。offscreen 文档只有一个；若被 Chrome 回收、扩展更新或 SW 重启导致 port
   断开，活动流会失败。SW 本身仍可能被回收，靠 offscreen ping、页面 ping 和 alarm
   续命，但不是绝对保证。
2. **SSE 无断点续传**：连接中断后不能从上次 token 恢复；SDK 会抛
   `SW_DISCONNECTED` / `STREAM_INTERRUPTED` / `OFFSCREEN_DISCONNECTED`，由用户决定
   是否重新请求。重新请求可能重复计费。
3. **未修改的第三方网页**：本扩展不是 HTTP 服务器，不能给 Chatbox 之类的页面一个
   API URL。网页必须集成 SDK；或者另外在 MAIN world 里 monkey-patch `fetch`（本项目
   不提供，且脆弱）。如果目标网页只支持自定义 API host，扩展本身无法直接接管。
4. **User-Agent**：通过 DNR 设置；不同 Chrome 版本的实际行为建议验证。
5. **不是官方客户端**：OpenCode 的 validated clients 列表不包含本项目；官方不保证
   未来兼容性。
6. **API key 存储**：`storage.local` 不是硬件级密钥存储；本机恶意软件、拥有本地
   文件访问权限的程序仍可能读取。
7. **Safari**：网页到扩展使用 content script 中继，必须先按站点授权 Website Access；
   没有 offscreen，长流依赖 Service Worker（25 秒首字节 / 5 分钟单请求）；Safari
   回收 Service Worker 时活动流会以 `SW_DISCONNECTED` / `RELAY_CLOSED` 失败，不能
   续传。Safari 16.4 以下对 MV3 service worker 支持不完整，建议使用 16.4+。
8. **多模态**：桥接只做 JSON 透传，不转换 content part，也不支持二进制 / `FormData`
   上传；能使用哪些模态由上游模型决定。默认请求体上限 32 MiB，大文件优先用 URL。

---

## 测试

纯函数、SSE 解析器和 SDK 协议路由有 Node 测试：

```bash
npm test
```

真实 Chromium 浏览器测试：

```bash
# CHROME_BIN 指向你的 Chrome/Chromium（需要 Chromium 120+）
CHROME_BIN=/usr/lib/chromium/chromium npm run test:browser
# 等价于 node tests/browser/run-all.mjs
```

它会启动一个临时 profile、加载扩展，并跑：

- options/storage/DNR/offscreen 创建；
- 内部可信端口 + stubbed offscreen fetch 的流式/非流式/Responses/Anthropic Messages/错误/取消；
- content script 中继路径（本地 HTTP 页面 + relay 端口，含未授权 Origin 拒绝）；
- 首字节延迟（`--first-byte`）和 6 分钟长流（`--long`）；
- offscreen 中途关闭、重建恢复、Service Worker 中途停止。

本次环境的结果和限制见 [tests/browser/RESULTS.md](tests/browser/RESULTS.md)。  
真实网络与 OpenCode API 的手动验收清单见 [tests/manual-checklist.md](tests/manual-checklist.md)。

---

## 项目结构

```text
manifest.json
background/service-worker.js
content/relay.js
offscreen/offscreen.html
offscreen/offscreen.js
lib/validation.js
options/index.html
options/options.js
options/options.css
sdk/opencode-bridge.js
demo/index.html
demo/demo.js
demo/demo.css
tests/
tests/browser/
README.md
SECURITY.md
API_COMPATIBILITY.md
PRIVACY.md
LICENSE
```

---

## License

MIT. See [LICENSE](LICENSE).

本项目不是 OpenCode 官方项目，也不代表 OpenCode 的立场或保证。
