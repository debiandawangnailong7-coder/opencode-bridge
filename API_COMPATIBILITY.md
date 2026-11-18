# API compatibility notes

This document records the API shapes implemented by the bridge and the points
that should be checked against OpenCode's live documentation.

Checked against the public docs on 2026-11-17. The official docs are
authoritative and may change.

## Base URLs

| Plan | Base URL |
|---|---|
| Console pay-as-you-go | `https://opencode.ai/inference` |
| OpenCode Go | `https://opencode.ai/inference/go` |

The bridge stores the provider as `console`, `go`, or `custom`. It builds:

```text
{base}/openai/v1/chat/completions
{base}/openai/v1/responses
{base}/anthropic/v1/messages
{base}/v1/models
```

## Authentication and session headers

```http
Authorization: Bearer oc_sk_...
Content-Type: application/json
x-opencode-session: ses_...
anthropic-version: 2023-06-01   # only for anthropic.messages
```

- `Authorization` is always injected from local storage.
- `x-opencode-session` is sent for chat/responses/anthropic.messages; it is not
  sent for `models.list`.
- `anthropic-version` is set by the bridge only for `anthropic.messages`.
  Current OpenCode docs do not list it as required; it is sent for Anthropic
  client compatibility.
- Go requires a stable session ID. Console recommends one.
- The SDK generates a `ses_` ID per conversation and reuses it for all turns,
  tool calls, retries, and model switches in that conversation.
- A new conversation gets a new ID. Forked conversations should get a new ID.

## User-Agent

Go's docs ask a client to identify itself with its own user agent rather than a
generic SDK/HTTP-library name. Chrome drops `User-Agent` from fetch requests, so
the bridge uses `declarativeNetRequest` with a session rule:

```text
condition: { requestDomains: [host], tabIds: [-1] }
action: modifyHeaders -> user-agent: set <configured value>
```

Default:

```text
opencode-bridge/0.2.0
```

The default is derived from `chrome.runtime.getManifest().version`. Existing
users keep their saved value. The value is configurable in the options page. Do
not configure a value that impersonates Claude Code, Codex, OpenCode, or another
validated client.

> `tabIds: [-1]` is documented as `TAB_ID_NONE`, matching requests that do not
> originate from a tab. The rule therefore targets non-tab requests to the
> configured host, including extension service-worker/offscreen fetches, and
> excludes tab-originating requests such as the user's own `opencode.ai` tabs.
> It is not a strict extension-initiator-only rule: `initiatorDomains` is not
> used, and Chrome docs do not establish extension-origin support for it.
> Verify the actual behavior on the target Chrome version.

## Model IDs

Use the API model IDs shown by the model list endpoint, for example:

```text
kimi-k3
glm-5.3
gpt-6-luna
claude-haiku-5-5
gemini-4-argon
```

Do not send the OpenCode config prefix:

```text
opencode-go/kimi-k3   # OpenCode config only; not the API model field
```

The bridge does not add or strip this prefix. It passes the body through
unchanged, so an invalid model ID is returned by the upstream API.

## Request bodies

The bridge does not modify the body. It validates only:

- it is a JSON object;
- `model` is a non-empty string;
- `stream`, if present, is a boolean;
- `messages` (Chat Completions), if present, is an array;
- `input` (Responses), if present, is a string or array;
- `messages` (Anthropic Messages) is an array;
- `max_tokens` (Anthropic Messages) is a positive integer;
- `system` (Anthropic Messages), if present, is a string or an array of
  content-block objects;
- `tools` (Anthropic Messages), if present, is an array.

Callers are responsible for using the shape the endpoint expects:

```json
{
  "model": "kimi-k3",
  "messages": [{ "role": "user", "content": "Say hi." }],
  "stream": true
}
```

```json
{
  "model": "gpt-6-luna",
  "input": "Say hi.",
  "stream": true
}
```

```json
{
  "model": "claude-haiku-5-5",
  "max_tokens": 128,
  "system": "You are helpful.",
  "messages": [{ "role": "user", "content": "Say hi." }],
  "stream": true
}
```

Anthropic Messages is supported through `/anthropic/v1/messages`. Gemini's
`:generateContent` / `:streamGenerateContent` path is not exposed by this MVP.
Text models that use another native API can also be called through the
OpenAI-shaped endpoints, where OpenCode translates the request.

### Multimodal content

The bridge does not inspect `messages`, `content`, or `input` below the top
level. Content arrays and individual parts are forwarded unchanged:

- Chat Completions: `image_url`, `input_audio`, `file`, and other parts.
- Anthropic Messages: `image` with `source`, `document`, `tool_result`, etc.
- Responses: `input_image`, `input_file`, `input_audio`, etc.

These are examples, not an allowlist. The bridge does not translate parts
between API shapes and does not check model capabilities; the upstream API and
the selected model decide whether a part is accepted.

The body must be valid JSON. Binary data must be base64-encoded or referenced by
URL; `FormData` and raw binary uploads are not supported. The default maximum
body is 32 MiB and is configurable in the options page (1–32 MiB). Prefer HTTPS
image URLs for large images. A body over the limit returns `BODY_TOO_LARGE`.

## Streaming

- `Accept: text/event-stream` is set when `body.stream === true`.
- The extension forwards decoded text chunks as they arrive; it does not wait
  for the full response.
- The SDK buffers partial SSE events and handles `\n`, `\r\n`, and `\r` line
  endings, multi-line `data:` fields, comments, `event:`, `id:`, `retry:`, and
  the `[DONE]` sentinel.
- Chat Completions chunks are typically OpenAI `choices[].delta` objects.
- Responses chunks use event types such as `response.output_text.delta` and
  `response.completed`.
- Anthropic Messages streams use `event:` names such as `message_start`,
  `content_block_delta`, `message_delta`, and `message_stop`. They are forwarded
  unchanged; Anthropic does not require a `[DONE]` sentinel, and the SDK ends the
  iterator when the stream closes.
- The final usage/cost fields are forwarded if the upstream sends them. For
  Chat Completions, request `stream_options.include_usage: true` if you need the
  final usage chunk.

## Non-streaming

- The extension sends `accepted`, then `response` with the raw body, then
  `done`.
- The SDK exposes `{ status, headers, body, json }`.
- `json` is a best-effort parse; `body` is always the raw text.

## Errors

The extension distinguishes:

| Code | Meaning |
|---|---|
| `AUTH_MISSING` | No key saved in options |
| `ORIGIN_DENIED` | Page origin not in the allowlist |
| `BAD_REQUEST` | Invalid API/body/model/stream |
| `BAD_BODY` | Body is not JSON-serializable |
| `BAD_REQUEST_ID` | Invalid request ID |
| `DUPLICATE_REQUEST_ID` | Request ID already in use on this port |
| `BAD_SESSION_ID` | Invalid session ID |
| `BODY_TOO_LARGE` | Request body over the limit |
| `CONCURRENCY_LIMIT` | Too many active requests |
| `CONNECT_TIMEOUT` | No upstream response within the bridge timeout |
| `NETWORK_ERROR` | Network/fetch failure |
| `UPSTREAM_HTTP_ERROR` | Non-2xx upstream response |
| `UNEXPECTED_REDIRECT` | Final URL origin did not match the configured base |
| `RESPONSE_READ_ERROR` | Could not read the upstream response body |
| `RESPONSE_TOO_LARGE` | Response/stream exceeded the 32 MiB bridge limit |
| `STREAM_ERROR` | Stream read failure |
| `CONFIG_ERROR` | Invalid provider/base URL configuration |
| `OFFSCREEN_ERROR` | Could not start the offscreen executor |
| `OFFSCREEN_DISCONNECTED` | Long-stream executor went away; not resumed |
| `SW_DISCONNECTED` | Extension worker/port went away |
| `ABORTED` | Caller cancelled |
| `INTERNAL_ERROR` | Unexpected bridge error |
| `CLOSED` | SDK instance was closed |

Non-2xx responses include `status`, `statusText`, sanitized `headers`, and a
truncated `body`. The bridge does not convert all upstream failures to HTTP 500
and does not retry automatically.

Common upstream meanings (verify against current docs):

- `401` / `403`: key invalid, plan mismatch, free-tier chat model restriction,
  region/training restriction, SSO session expired, or missing permission.
- `429`: rate/usage limit; check `Retry-After` and the Go usage windows.
- `413`: request too large.
- `5xx`: upstream failure; retry only if the caller decides it is safe.

## Privacy and data terms

Model training and retention differ by model. Go's privacy settings and the
Console workspace's privacy settings apply. The bridge does not add a privacy
guarantee and does not log prompts or responses. See [PRIVACY.md](PRIVACY.md)
and the official OpenCode privacy documentation.

## Verification notes

- Confirm on the target Chrome version that the DNR User-Agent rule applies to
  non-tab service worker/offscreen fetches. Chrome drops `User-Agent` set
  directly by `fetch`. The rule is not an extension-initiator-only filter.
- Confirm the upstream accepts `anthropic-version: 2023-06-01` on the Anthropic
  Messages path; current OpenCode docs do not list it as required.
- Observe whether the upstream receives an `Origin: chrome-extension://...`
  header. `Origin` is a forbidden request header and cannot be forged from
  `fetch`; if the API rejects extension origins, that is a platform blocker
  rather than something the bridge can patch.
- Confirm the API accepts `Authorization: Bearer ...` for both Console and Go
  with the selected plan. A key from one plan against the other base URL can
  produce 401/403/404.
- Confirm the offscreen document is created and stays connected while a long
  stream runs; check `chrome://extensions` service worker/offscreen logs. If
  Chrome reclaims it, the client should receive `OFFSCREEN_DISCONNECTED`.
- Confirm the DNR User-Agent rule also applies to offscreen-document fetches,
  not just service-worker fetches.
- Confirm the Go free/restricted models behave as documented for the user's
  workspace region and privacy settings.

## Manual compatibility matrix

| Case | Expected |
|---|---|
| Chat Completions, non-stream | JSON body, status forwarded |
| Chat Completions, stream | SSE chunks, `[DONE]` ends |
| Responses, non-stream | JSON body |
| Responses, stream | Responses event types forwarded |
| Anthropic Messages, non-stream | JSON body with `type: "message"` |
| Anthropic Messages, stream | `event:` frames forwarded; ends on stream close, no `[DONE]` required |
| Multimodal content parts | Forwarded unchanged; upstream/model decides |
| Chat Completions request to Claude/Gemini model | Console translates or returns documented error |
| Invalid model ID | Upstream 4xx forwarded |
| No API key | `AUTH_MISSING` |
| Wrong plan/base URL | 401/403/404 forwarded |
| Free-tier Console chat model from bridge | 403 forwarded |
| 429 with `Retry-After` | Error includes header |
| Cancel mid-stream | `cancelled` / `ABORTED`; partial billing possible |
| Concurrent requests | Isolated by request ID; limits enforced |
| UTF-8 split across chunks | No replacement characters |
| Long stream | Runs in offscreen document; SW only routes; not bound by the SW 5-minute request timer |
| Disallowed origin | `ORIGIN_DENIED` / fatal |
| Redirect to another host | `UNEXPECTED_REDIRECT` / fetch error |
| Body over configured limit (default 32 MiB) | `BODY_TOO_LARGE` |
| Session ID missing | Bridge generates one; SDK normally supplies it |

## Official references

- <https://opencode.ai/docs/console/go>
- <https://opencode.ai/docs/console/api>
- <https://opencode.ai/docs/console/api/inference>
- <https://opencode.ai/docs/console/harnesses>
- <https://opencode.ai/docs/console/models>
- <https://opencode.ai/legal/terms-of-service>
