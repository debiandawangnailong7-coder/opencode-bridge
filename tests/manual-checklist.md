# Manual acceptance checklist

Run Node unit tests first:

```bash
npm test
```

Then load the unpacked extension and serve the demo:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/demo/` and `chrome://extensions` in Chrome.

## Installation and configuration

- [ ] Extension loads without manifest errors.
- [ ] Options page opens.
- [ ] No key configured: a request returns `AUTH_MISSING`, not a network call.
- [ ] Save a key; options shows only a mask, never the full key.
- [ ] Reload the options page: key is still saved and masked.
- [ ] Clear key: a request returns `AUTH_MISSING`.
- [ ] Add `http://localhost:8000` to allowed origins; save.
- [ ] Remove it; a request is rejected with `ORIGIN_DENIED`.
- [ ] Add `https://example.com/app` as an origin: rejected as a path.
- [ ] Add `https://example.com.evil` and ensure it cannot impersonate an allowed
      `https://example.com`.

## Provider and endpoints

- [ ] Console provider uses `https://opencode.ai/inference`.
- [ ] Go provider uses `https://opencode.ai/inference/go`.
- [ ] Custom provider requests optional host permission on save.
- [ ] Invalid custom URL (http, localhost, private IP, query) is rejected.
- [ ] Custom provider works with a mock/compatible HTTPS endpoint if one is
      available.
- [ ] Switching away from custom removes the old optional host permission
      (check `chrome://extensions` site access).

## API behavior

- [ ] Chat Completions non-stream returns JSON and status.
- [ ] Chat Completions stream shows text progressively.
- [ ] Responses non-stream returns JSON.
- [ ] Responses stream forwards event types.
- [ ] `[DONE]` ends the stream without an error.
- [ ] Model IDs use `kimi-k3`, not `opencode-go/kimi-k3`.
- [ ] A wrong model returns the upstream 4xx error.
- [ ] A free-tier Console chat model from the bridge returns 403 (current docs).
- [ ] `429` includes `Retry-After` if the upstream provides it.
- [ ] `401` / `403` do not expose the API key in the error.
- [ ] `stream_options.include_usage` final usage/cost is visible.
- [ ] Chat Completions to a Claude/Gemini model works or returns the documented
      upstream error.
- [ ] Anthropic Messages non-stream returns a JSON body with `type: "message"`.
- [ ] Anthropic Messages stream forwards `event:` frames and ends on stream
      close; no `[DONE]` sentinel is required.
- [ ] Anthropic request sends `Authorization`, `x-opencode-session`,
      `anthropic-version: 2023-06-01`, and `Accept: text/event-stream` (verify
      via mock-server log or DevTools).
- [ ] Missing `max_tokens` is rejected locally with `BAD_REQUEST`.
- [ ] Anthropic upstream 4xx/5xx keeps status and body.
- [ ] Anthropic cancel aborts the upstream request.

## Streaming and lifecycle

- [ ] Cancel mid-stream: UI shows cancelled; upstream request aborts.
- [ ] Navigate away mid-stream: no unhandled errors; upstream aborts.
- [ ] Close the page mid-stream: extension does not keep a runaway request.
- [ ] Two tabs with different conversations do not mix output.
- [ ] Two concurrent requests on one port have separate request IDs.
- [ ] Chinese and emoji split across network chunks render correctly.
- [ ] A model pause longer than 30 seconds does not always kill the stream
      (offscreen/page heartbeat + alarm).
- [ ] `chrome://extensions` shows an offscreen document while a request runs.
- [ ] A stream longer than 5 minutes completes (or reports a clear
      `OFFSCREEN_DISCONNECTED` / `SW_DISCONNECTED`); it does not hang forever.
- [ ] A non-stream request that takes longer than 30 seconds completes via
      offscreen (not the SW fetch timeout).
- [ ] Reload the extension service worker mid-stream; SDK reports disconnection.
- [ ] Stop the offscreen document from DevTools mid-stream; SDK reports
      `OFFSCREEN_DISCONNECTED`; a new request recreates it.
- [ ] After the service worker is stopped, the next request recreates/connects
      the offscreen executor.
- [ ] No automatic retry occurs after a network failure.

## Network and security

- [ ] `fetch` redirects are rejected (`redirect: "error"`).
- [ ] A final response URL from a different origin is rejected.
- [ ] Request body over the limit returns `BODY_TOO_LARGE`.
- [ ] More than the global/per-origin concurrency limit returns
      `CONCURRENCY_LIMIT`.
- [ ] A page cannot send `url`, `method`, `headers`, or `Authorization` fields
      to affect the upstream request.
- [ ] A page cannot read the API key through messages or errors.
- [ ] The options page does not render the stored key.
- [ ] Extension logs contain no prompts, responses, or API keys.
- [ ] `chrome.storage.local.setAccessLevel` is called; the content-script relay
      cannot read the key. The relay source contains no storage access.
- [ ] DNR User-Agent rule uses `requestDomains: [host]` + `tabIds: [-1]`; it
      applies to non-tab extension/offscreen requests and does not alter the
      user's own `opencode.ai` tab requests. It is not a strict
      extension-initiator-only filter (verify with a mock server or DevTools).

## Transport selection

- [ ] Chrome, allowed origin: `bridge.transport === "direct"` and behavior is
      unchanged.
- [ ] Chrome, forced `transport: "relay"` on an allowed origin: stream,
      non-stream, cancel, and `ORIGIN_DENIED` for a non-allowed origin all work.
- [ ] Chrome, forced `transport: "relay"` with the content script unavailable
      (e.g. extension disabled for the site): fails with
      `CONTENT_SCRIPT_MISSING` and a Website Access hint.

## Safari

- [ ] `xcrun safari-web-extension-converter` produces a runnable app; the
      extension appears in Safari settings.
- [ ] Developer build requires Develop → Allow Unsigned Extensions; the
      extension loads.
- [ ] Options page shows a bundle-ID Extension ID (e.g. `com.…`) and the Safari
      transport/Website Access note.
- [ ] Without Website Access for the site: the SDK fails with
      `CONTENT_SCRIPT_MISSING` and the hint, not a hang.
- [ ] With Website Access for `http://localhost:8000`: the demo connects,
      `bridge.transport === "relay"`, and streaming text renders.
- [ ] Non-allowlisted origin through the relay returns `ORIGIN_DENIED`.
- [ ] Cancel mid-stream aborts through the relay.
- [ ] A stream of at least 2 minutes completes, or fails clearly with
      `SW_DISCONNECTED` / `RELAY_CLOSED`; it does not hang.
- [ ] No offscreen document is used; requests still run through the service
      worker (25 s first-byte / 5 min request limits).
- [ ] Check whether Safari applies the DNR User-Agent rule; if not, verify
      whether the default UA is sent (capture with a mock server or proxy).

## Policy documentation

- [ ] README states that the extension does not enforce OpenCode subscription
      policy.
- [ ] README links to the official Go, API, and Terms pages.
- [ ] README does not claim official affiliation or validation.
- [ ] README does not provide a "pretend to be Claude Code/Codex" feature.
- [ ] No API key is bundled, shared, or proxied through a server.

## Known expected limitations

- [ ] Unmodified third-party chat pages cannot use the bridge without an SDK or
      a MAIN-world fetch patch; this is documented, not treated as a bug.
- [ ] SSE cannot resume after a disconnect; retry is a new request and may
      double-bill.
- [ ] Very long streams may hit Chrome MV3 service worker limits.
