# Security design

This document describes the trust boundaries of OpenCode Bridge. It is not a
claim that the extension is suitable for high-security environments.

## Trust model

- The user trusts the extension code installed in their own Chrome profile.
- The extension trusts web pages only if their exact Origin is listed in the
  options page.
- The extension does **not** trust the web page with the API key.
- The extension does **not** trust the web page to choose arbitrary URLs,
  methods, headers, or authorization values.
- OpenCode is an external service. Requests sent to it are subject to OpenCode's
  terms and privacy policy.

## Origin validation

There are two entry points, both gated by the same runtime allowlist:

1. `externally_connectable.matches` (`http://*/*`, `https://*/*`) lets any
   http/https page call `chrome.runtime.connect(extensionId)`. Ports arrive on
   `onConnectExternal`.
2. A content script (`content/relay.js`) is injected on http/https pages and
   relays `window.postMessage` envelopes to an internal port named
   `opencode-bridge-relay`. Ports from content scripts arrive on `onConnect`.

Neither entry point is authorization. For both, the service worker:

- requires `sender.id` to be this extension (entry point 2);
- reads `port.sender.origin`;
- rejects missing, empty, `null`, or non-http(s) origins; if `origin` is absent
  (some Safari content-script ports), derives it from the browser-provided
  `sender.url` instead — a page cannot spoof either field;
- if `port.sender.url` is present, parses it and requires its origin to equal
  `sender.origin`;
- requires an exact string match against `allowedOrigins`;
- applies no prefix matching, wildcard matching, or subdomain matching;
- defaults `allowedOrigins` to an empty array.

For the relay, the page origin is `sender.origin` — the origin of the page that
injected the content script — so a relay port cannot bypass the allowlist.
Denied relay ports receive the same `fatal / ORIGIN_DENIED` and are disconnected.

Consequences:

- A page on an allowed origin is fully trusted by this extension. Any script
  running in that origin can use the bridge, including third-party scripts.
  Origin-level authorization cannot distinguish scripts inside the same origin.
- If the allowlist is misconfigured, the bridge can be used by a page the user
  did not intend to authorize.

## Trusted extension pages

Extension pages with the same extension ID (for example the options page or a
debug harness) may use an internal `chrome.runtime.connect` port with the same
request protocol. This is not a new privilege: extension pages can already read
the saved key. The service worker still checks `sender.id` and requires
`sender.url` to start with `chrome-extension://<this-extension-id>/`.

Web pages never use this internal path; they go through
`onConnectExternal` and the runtime Origin allowlist described above.

## Content-script relay

`content/relay.js` exists so Safari web pages, which cannot reliably use the
direct `externally_connectable` channel, can still reach the extension.

- It runs in the extension's isolated content-script world, holds no API key,
  never reads `chrome.storage`, and makes no origin-policy decisions.
- It accepts `window.postMessage` envelopes only when
  `event.source === window` and `event.origin === location.origin`, and only
  forwards payloads for a `portId` the page opened. A subframe, another window,
  or another origin cannot inject messages into an existing port.
- It forwards the page's logical port to the service worker; the service worker
  then validates `sender.origin` / `sender.url` against the allowlist exactly as
  it does for `onConnectExternal`.
- A malicious page on a *non-allowed* origin therefore gets
  `ORIGIN_DENIED`; a malicious page on an *allowed* origin is already trusted
  at origin level (see the consequence above).
- Because content scripts are injected on all http/https pages, the injection
  surface is broad, but the relay itself cannot read credentials or storage and
  is not an authorization bypass. `chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS" })` blocks content-script reads of the key.

## API key handling

- The key is stored in `chrome.storage.local`.
- `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` is
  called on install/startup so the content-script relay cannot read it. This is
  defense in depth: the relay never attempts storage access.
- The key is never sent to a web page, the SDK, a log, an error message, a URL,
  a query string, or a DNR rule.
- The key is read from storage for each upstream request and placed only in the
  `Authorization` request header.
- `chrome.storage.local` is not encrypted at rest and is not a hardware-backed
  secret store. Local malware, a compromised Chrome profile, or a process with
  access to the profile directory may be able to read it. The extension does not
  claim otherwise.

## Request validation

The page may send only:

```js
{
  type: "request",
  requestId: "req_...",
  api: "chat.completions" | "responses" | "anthropic.messages" | "models.list",
  body: object | null,
  sessionId: "ses_..." // optional
}
```

The extension rejects:

- unknown `api` values;
- non-object request bodies;
- missing or oversized `model`;
- non-boolean `stream`;
- for `anthropic.messages`: missing/non-array `messages`, non-positive-integer
  `max_tokens`, invalid `system` (not string/content-block array), or
  non-array `tools`;
- invalid request IDs or session IDs;
- bodies larger than `maxBodyBytes` (default 4 MiB);
- duplicate request IDs on the same port;
- requests over the global/per-origin concurrency limits.

The page cannot provide:

- a target URL;
- an HTTP method;
- request headers;
- an `Authorization` value;
- a `User-Agent` value;
- a provider/base URL override for a single request.

This prevents the extension from becoming an open proxy.

## Network behavior

- Requests are made by the extension service worker or its offscreen document
  with host permissions.
- `redirect: "error"` is used, so a 3xx response fails instead of silently
  forwarding credentials to another host.
- The final `response.url` origin is checked against the configured base URL
  origin.
- Custom base URLs must use HTTPS and may not use localhost or private/reserved
  address literals. This includes IPv4 private, loopback, link-local, CGNAT,
  documentation, multicast, and reserved ranges; IPv6 unspecified, loopback,
  link-local, unique-local, multicast, documentation, IPv4-mapped/compatible,
  NAT64, and 6to4 forms that embed a forbidden IPv4 address; and trailing-dot
  `localhost` variants. DNS rebinding on an allowed custom hostname is not
  fully preventable from an extension; treat custom base URLs as trusted input.
- Custom base URLs require an optional host permission granted from the options
  page.
- The extension does not disable CORS, does not use `--disable-web-security`,
  and does not modify `Access-Control-Allow-Origin`.
- The client User-Agent is set by a session-scoped DNR rule with
  `requestDomains: [host]` and `tabIds: [-1]`. This matches non-tab requests to
  the configured host, including extension service-worker/offscreen fetches,
  and excludes tab-originating requests such as the user's own `opencode.ai`
  tabs. It is not a strict extension-initiator-only rule; `initiatorDomains` is
  not used.
- `anthropic-version: 2023-06-01` is set by the bridge only for
  `anthropic.messages`; it is not page-controlled.

Residual risk: a user can intentionally configure a public custom base URL and
send their key there. That is an explicit user decision; the options UI warns
about the permission and the URL is validated, but the extension cannot know
whether the custom service is trustworthy.

## Streaming and cancellation

- SSE bodies are read with `ReadableStream` and decoded with a streaming
  `TextDecoder`.
- Response headers that would be incorrect after browser decompression or
  re-framing are stripped: `content-encoding`, `content-length`,
  `transfer-encoding`, `connection`, `set-cookie`, etc.
- Cancellation aborts the upstream fetch via `AbortController`. Partial usage
  may still be billed by OpenCode.
- No automatic retry is performed. Retrying a POST can duplicate charges.

## Service worker lifetime and offscreen execution

MV3 service workers can be stopped after idle periods and long requests can hit
the per-event/request limit. To keep long code-agent turns from depending on the
service worker's request timer, inference requests (both streaming and
non-streaming) run in an **offscreen document**:

- The service worker validates the request, enforces concurrency/body limits,
  and routes messages. Its event handlers return quickly.
- The offscreen document performs `fetch`, reads the response body, decodes
  UTF-8, and sends chunks back through the service worker.
- The offscreen document sends a heartbeat to the service worker every 20
  seconds while requests are active; the service worker also creates a
  30-second alarm. The page SDK sends its own 20-second heartbeat.
- The offscreen document is an extension context with host permissions; the API
  key is in its memory but never in a web page.
- The offscreen document uses the `WORKERS` reason because Chrome does not have
  a network reason. This is a review consideration if published.
- Only one offscreen document exists per profile. If Chrome reclaims it, the
  extension update reloads it, or the service worker restarts, active streams
  fail with `OFFSCREEN_DISCONNECTED` / `SW_DISCONNECTED`; the bridge does not
  pretend the stream was resumed.
- If offscreen creation is unavailable, the bridge falls back to service worker
  `fetch`, which is subject to the shorter first-byte/request limits. The
  fallback is logged as a non-sensitive warning.

## Logging

- No request prompts, response bodies, API keys, or session contents are logged.
- A non-sensitive warning may be logged if a DNR rule cannot be applied.
- The options page does not render the saved key; it only shows a mask.

## Chrome Web Store considerations

If this extension is published, expect review of:

- broad `externally_connectable` matches;
- a content script declared for all http/https pages;
- `optional_host_permissions` for custom base URLs;
- `declarativeNetRequest` header modification;
- the `offscreen` permission and the `WORKERS` justification;
- storage of a sensitive API key;
- the single-purpose policy, privacy disclosure, and limited-use requirements.

Do not add remote code, telemetry, or a shared API key to a published build.

## Reporting

This is a local open-source project. If you find a security issue, open a private
report with the maintainer rather than publishing a working exploit.
