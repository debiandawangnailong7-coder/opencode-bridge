# Browser test results

Date: 2026-11-17

Environment:

- Debian GNU/Linux 13 (trixie), x86_64
- Chromium 156.0.8078.79 (`/usr/lib/chromium/chromium`, headless new mode)
- Node.js 24.22.2
- Chrome flags: `--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage`
- Extension loaded with `--disable-extensions-except` + `--load-extension`

## Passed

### Extension plumbing

- Manifest loads, extension service worker starts.
- Options page loads.
- Provider, API key, allowed origins, and User-Agent save correctly.
- API key input is cleared after save; placeholder shows a saved mask.
- An origin with a path is rejected with a specific error and does not
  overwrite the previous allowlist.
- DNR session rule is registered:
  - `requestDomains: ["opencode.ai"]`
  - `tabIds: [-1]`
  - `user-agent` set to the configured value
- Offscreen document can be created and closed through the extension API.

### Anthropic Messages transport (issue #1)

- `conversation.messages.create(...)` stream: Anthropic `event:` frames pass
  through; the iterator ends on stream close without a `[DONE]` sentinel.
- Non-stream returns the Anthropic message JSON.
- `anthropic-version: 2023-06-01` is sent only on the Anthropic path.
- `Authorization` and `x-opencode-session` headers are injected as for other
  inference requests; `Accept` switches between SSE and JSON.
- Missing `max_tokens` is rejected locally with `BAD_REQUEST`.
- Anthropic cancellation aborts the offscreen stream.
- A non-OpenCode `/v1/messages` URL is not intercepted by the fetch adapter in
  the SDK protocol test.
- IPv6 private/reserved custom-base-URL forms (including IPv4-mapped, link-local,
  unique-local, NAT64, 6to4, documentation, and `localhost.`) are rejected by
  unit tests; a public IPv6 literal is accepted.
- DNR session-rule configuration is asserted in the browser protocol test.

### Protocol / streaming (stubbed offscreen fetch)

The tests use the real extension service worker, real offscreen document, real
internal trusted port, and the real web SDK, but replace `fetch` inside the
offscreen document with a controllable mock:

- Chat Completions stream: three SSE chunks joined to `hello world`.
- Non-stream JSON: status and parsed JSON returned.
- Responses API stream: `response.output_text.delta` events parsed.
- `Authorization` header injected from extension storage.
- Stable `x-opencode-session` header matches the SDK conversation.
- `Accept: text/event-stream` for streams.
- Request body passes through unchanged.
- Upstream 429 error code, status, and `Retry-After` header are forwarded.
- Cancel: SDK reports `ABORTED`, and the offscreen stream is cancelled.
- First-byte delay of 35 seconds: request completes through offscreen.
- Long stream of 6 minutes: completes; does not hit the Service Worker
  5-minute request timer.

### Failure and recovery

- Closing the offscreen document mid-stream produces
  `OFFSCREEN_DISCONNECTED` in the page SDK.
- Recreating the offscreen document allows the next request to succeed.
- Closing the extension service worker target mid-stream produces
  `SW_DISCONNECTED` (or an offscreen disconnect) and does not hang silently.

## Not verified in this environment

### Content-script relay path

`tests/browser/relay-test.mjs` serves the page and SDK from a local HTTP server
so the manifest content script is injected, then forces `transport: "relay"`.
In this sandbox Chromium blocks renderer navigation (including to `127.0.0.1`),
so the test prints `SKIP` and exits 0; it is wired into `run-all.mjs` and runs
automatically where renderer navigation works. Node tests
(`tests/sdk-transport.test.js`) cover transport selection, the direct-to-relay
fallback, envelope direction/origin checks, and close/listener cleanup.

### Real outbound network / real OpenCode API

The sandbox's Chromium network path is blocked before normal renderer and
extension `fetch` requests leave the browser:

- Page navigation to local/external HTTP/HTTPS hangs.
- Renderer `fetch` to local/external URLs fails without reaching a local
  server.
- SOCKS5 and HTTP CONNECT proxies accept the browser's CONNECT, but Chrome's
  TLS handshake does not complete in this environment.
- Extension service worker `fetch` to a mapped `opencode.ai` mock also does not
  reach the mock.

Therefore the following were **not** tested against a live endpoint:

- Actual OpenCode authentication and model responses.
- Real User-Agent observed on the wire (the DNR rule itself is registered and
  verified through `getSessionRules`).
- Whether the upstream accepts `Origin: chrome-extension://...`.
- Go/Console plan mismatch, free-tier 403, region/training restrictions, SSO,
  budgets, and real cost/allowance fields.

### External web page path

`tests/browser/external-page-test.mjs` attempts to serve a page with CDP
`Fetch` interception so the external `externally_connectable` path can be
tested without real network. In this environment the navigation request is
blocked before the `Fetch` domain sees it, so the external page path could not
be exercised.

Covered indirectly:

- Origin normalization/path rejection is unit-tested.
- The options UI rejects a path-bearing origin.
- Unit tests cover exact matching and prefix-bypass rejection.
- The internal trusted port path is fully tested.

The manual checklist still requires a normal desktop Chrome run for:

- Allowed vs denied external origins.
- Real `externally_connectable` connection from `https://...`.
- Real User-Agent on the wire.
- Real OpenCode API behavior and long streams over the network.

## Reproduce

```bash
CHROME_BIN=/usr/lib/chromium/chromium node tests/browser/run-all.mjs
CHROME_BIN=/usr/lib/chromium/chromium node tests/browser/run-all.mjs --first-byte
CHROME_BIN=/usr/lib/chromium/chromium node tests/browser/run-all.mjs --long
```

`--long` takes at least six minutes. `run-all.mjs` launches a temporary
profile and cleans it up.

`external-page-test.mjs` is separate because it requires working renderer
navigation or working CDP Fetch interception:

```bash
# after starting Chromium with the extension and a CDP port:
node tests/browser/external-page-test.mjs <cdpPort>
```
