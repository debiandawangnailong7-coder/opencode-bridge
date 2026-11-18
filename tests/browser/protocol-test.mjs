// Browser integration tests for the bridge protocol, using a stubbed
// offscreen fetch. This exercises the real extension service worker,
// offscreen document, internal trusted port, SDK, SSE parser, and routing
// without depending on outbound network.
//
// Usage: start Chromium with the extension and a CDP port, then:
//   node tests/browser/protocol-test.mjs <cdpPort> [--first-byte] [--long]

import { listTargets, createTarget, connectTarget, sleep } from "./cdp.mjs";

const port = Number(process.argv[2] || 9480);
const runFirstByte = process.argv.includes("--first-byte");
const runLong = process.argv.includes("--long");

let failures = 0;
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`);
  }
}

const targets = await listTargets(port);
const sw = targets.find((t) => t.type === "service_worker" && t.url.includes("/background/service-worker.js"));
if (!sw) throw new Error("Extension service worker target not found.");
const extensionId = new URL(sw.url).host;
console.log("EXTENSION_ID", extensionId);

const swCdp = await connectTarget(sw);
await swCdp.send("Runtime.enable");

// Configure the extension through its real options page.
const optionsTarget = await createTarget(port, "about:blank");
const options = await connectTarget(optionsTarget);
await options.send("Runtime.enable");
await options.send("Page.enable");
await options.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/index.html` });
await sleep(800);
await options.evaluate(`
  document.getElementById('provider').value = 'go';
  document.getElementById('clientUserAgent').value = 'ocb-browser-test/1.0';
  document.getElementById('allowedOrigins').value = 'https://demo.test';
  document.getElementById('apiKey').value = 'oc_sk_browser_test';
  document.getElementById('save').click();
  'clicked'
`);
await options.waitFor(async () => {
  const text = await options.evaluate('document.getElementById("status").textContent');
  return text.includes("saved");
}, 5000);

const optionsInfo = await options.evaluate(`({
  version: document.getElementById('extensionVersion').textContent,
  expected: 'v' + chrome.runtime.getManifest().version,
  maxBodyMiB: document.getElementById('maxBodyMiB').value
})`);
check("options version matches manifest", optionsInfo.version === optionsInfo.expected, JSON.stringify(optionsInfo));
check("options default body limit", optionsInfo.maxBodyMiB === "32", JSON.stringify(optionsInfo));

let dnrRules = [];
await swCdp.waitFor(async () => {
  dnrRules = await swCdp.evaluate("chrome.declarativeNetRequest.getSessionRules()");
  return Array.isArray(dnrRules) && dnrRules.length > 0;
}, 5000).catch(() => {});
const dnrOk = Array.isArray(dnrRules) && dnrRules.some((rule) => (
  rule.condition?.requestDomains?.includes("opencode.ai")
  && rule.condition?.tabIds?.includes(-1)
  && rule.action?.requestHeaders?.some((header) => (
    header.header === "user-agent" && header.value === "ocb-browser-test/1.0"
  ))
));
check("DNR UA rule scoped to non-tab opencode.ai", dnrOk, JSON.stringify(dnrRules));

// Pre-create the offscreen executor and install a controllable fetch stub.
const created = await swCdp.evaluate(`
  chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: 'browser protocol test'
  }).then(() => 'created').catch(e => 'ERR:' + e.message)
`);
check("offscreen created", created === "created", created);

let offscreenTarget = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(200);
  const list = await listTargets(port);
  offscreenTarget = list.find((t) => t.url.includes("offscreen/offscreen.html"));
  if (offscreenTarget) break;
}
if (!offscreenTarget) throw new Error("Offscreen target not found.");
const offscreen = await connectTarget(offscreenTarget);
await offscreen.send("Runtime.enable");
await offscreen.evaluate(`(${installStub.toString()})()`);

async function setStub(config) {
  await offscreen.evaluate(`(${setStubConfig.toString()})(${JSON.stringify(config)})`);
}

// Load the real SDK in the trusted options page and connect through the
// extension-internal port.
await options.evaluate(`
  (async () => {
    const mod = await import('/sdk/opencode-bridge.js');
    self.__bridge = new mod.OpenCodeBridge({ extensionId: chrome.runtime.id });
    self.__conversation = self.__bridge.createConversation({ sessionId: 'ses_browser_test' });
    await self.__bridge.connect();
    return 'ready';
  })()
`);

const sessionId = await options.evaluate("self.__conversation.sessionId");

// 1. Chat Completions stream.
await setStub({ mode: "stream", frames: ["he", "llo", " world"] });
const chatChunks = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.chat.completions.create({
      model: 'mock-stream',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })()
`);
const chatText = chatChunks.map((c) => c?.choices?.[0]?.delta?.content || "").join("");
check("chat stream text", chatText === "hello world", chatText);
check("chat stream chunk count", chatChunks.length === 3, String(chatChunks.length));

const last = await offscreen.evaluate("self.__lastRequest");
check("authorization injected", last?.headers?.Authorization === "Bearer oc_sk_browser_test", JSON.stringify(last?.headers));
check("session header", last?.headers?.["x-opencode-session"] === "ses_browser_test", JSON.stringify(last?.headers));
check("session matches SDK", sessionId === "ses_browser_test", sessionId);
check("stream accept header", last?.headers?.Accept === "text/event-stream", JSON.stringify(last?.headers));
check("body passed through", String(last?.body || "").includes('"model":"mock-stream"'), String(last?.body));

// 2. Non-stream JSON.
await setStub({ mode: "json" });
const nonStream = await options.evaluate(`
  (async () => {
    const r = await self.__conversation.chat.completions.create({
      model: 'mock-echo',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    return { status: r.status, json: r.json };
  })()
`);
check("non-stream status", nonStream.status === 200, JSON.stringify(nonStream));
check("non-stream json", nonStream.json?.ok === true, JSON.stringify(nonStream));

// 3. Upstream error status/header passthrough.
await setStub({ mode: "error" });
const errorResult = await options.evaluate(`
  (async () => {
    try {
      await self.__conversation.chat.completions.create({
        model: 'mock-error', messages: [], stream: false
      });
      return { none: true };
    } catch (e) {
      return {
        code: e.code,
        status: e.status,
        message: e.message,
        retry: e.headers && e.headers['retry-after']
      };
    }
  })()
`);
check("upstream error code", errorResult.code === "UPSTREAM_HTTP_ERROR", JSON.stringify(errorResult));
check("upstream error status", errorResult.status === 429, JSON.stringify(errorResult));
check("retry-after passthrough", errorResult.retry === "2", JSON.stringify(errorResult));

// 4. Responses API stream.
await setStub({ mode: "stream", responses: true, frames: ["A", "B"] });
const responsesChunks = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.responses.create({
      model: 'mock-stream', input: 'hi', stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })()
`);
const responsesText = responsesChunks.map((c) => c?.delta || "").join("");
check("responses stream text", responsesText === "AB", responsesText);

// 5. Anthropic Messages stream (no [DONE] sentinel).
await setStub({ mode: "stream", anthropic: true, frames: ["he", "llo"] });
const anthropicChunks = await options.evaluate(`
  (async () => {
    const stream = await self.__conversation.messages.create({
      model: 'mock-stream',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  })()
`);
const anthropicText = anthropicChunks.map((c) => c?.delta?.text || "").join("");
check("anthropic stream text", anthropicText === "hello", anthropicText);
check("anthropic stream event count", anthropicChunks.length === 3, String(anthropicChunks.length));
const anthropicLast = await offscreen.evaluate("self.__lastRequest");
check("anthropic url", String(anthropicLast?.url || "").endsWith("/anthropic/v1/messages"), String(anthropicLast?.url));
check("anthropic authorization", anthropicLast?.headers?.Authorization === "Bearer oc_sk_browser_test", JSON.stringify(anthropicLast?.headers));
check("anthropic session", anthropicLast?.headers?.["x-opencode-session"] === "ses_browser_test", JSON.stringify(anthropicLast?.headers));
check("anthropic stream accept", anthropicLast?.headers?.Accept === "text/event-stream", JSON.stringify(anthropicLast?.headers));
check("anthropic version", anthropicLast?.headers?.["anthropic-version"] === "2023-06-01", JSON.stringify(anthropicLast?.headers));
check("anthropic body max_tokens", String(anthropicLast?.body || "").includes('"max_tokens":64'), String(anthropicLast?.body));

// 6. Anthropic Messages non-stream.
await setStub({ mode: "json", anthropic: true });
const anthropicNonStream = await options.evaluate(`
  (async () => {
    const r = await self.__conversation.messages.create({
      model: 'mock-echo',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    return { status: r.status, json: r.json };
  })()
`);
check("anthropic non-stream status", anthropicNonStream.status === 200, JSON.stringify(anthropicNonStream));
check("anthropic non-stream json", anthropicNonStream.json?.type === "message", JSON.stringify(anthropicNonStream));
const anthropicNonStreamLast = await offscreen.evaluate("self.__lastRequest");
check("anthropic non-stream accept", anthropicNonStreamLast?.headers?.Accept === "application/json", JSON.stringify(anthropicNonStreamLast?.headers));
check("anthropic non-stream version", anthropicNonStreamLast?.headers?.["anthropic-version"] === "2023-06-01", JSON.stringify(anthropicNonStreamLast?.headers));

// 7. Anthropic local validation.
const anthropicInvalid = await options.evaluate(`
  (async () => {
    try {
      await self.__conversation.messages.create({
        model: 'mock-echo',
        messages: [],
        stream: false
      });
      return { none: true };
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  })()
`);
check("anthropic missing max_tokens rejected", anthropicInvalid.code === "BAD_REQUEST", JSON.stringify(anthropicInvalid));

// 8. Cancellation.
await setStub({ mode: "endless", intervalMs: 50 });
const cancelPromise = options.evaluate(`
  (async () => {
    const controller = new AbortController();
    const stream = await self.__conversation.chat.completions.create({
      model: 'mock-cancel', messages: [], stream: true
    }, { signal: controller.signal });
    let count = 0;
    try {
      for await (const chunk of stream) {
        count += 1;
        if (count >= 2) controller.abort();
      }
      return { done: true, count };
    } catch (e) {
      return { code: e.code, count };
    }
  })()
`);
const cancelResult = await cancelPromise;
check("cancel code", cancelResult.code === "ABORTED", JSON.stringify(cancelResult));
check("cancel after chunks", cancelResult.count >= 2, JSON.stringify(cancelResult));
const stubCancelled = await offscreen.evaluate("!!self.__stubCancelled");
check("offscreen stream cancelled", stubCancelled === true, String(stubCancelled));

// 9. Anthropic cancellation.
await setStub({ mode: "endless", anthropic: true, intervalMs: 50 });
const anthropicCancel = await options.evaluate(`
  (async () => {
    const controller = new AbortController();
    const stream = await self.__conversation.messages.create({
      model: 'mock-cancel',
      max_tokens: 64,
      messages: [],
      stream: true
    }, { signal: controller.signal });
    let count = 0;
    try {
      for await (const chunk of stream) {
        count += 1;
        if (count >= 2) controller.abort();
      }
      return { done: true, count };
    } catch (e) {
      return { code: e.code, count };
    }
  })()
`);
check("anthropic cancel code", anthropicCancel.code === "ABORTED", JSON.stringify(anthropicCancel));
check("anthropic cancel after chunks", anthropicCancel.count >= 2, JSON.stringify(anthropicCancel));
const anthropicCancelled = await offscreen.evaluate("!!self.__stubCancelled");
check("anthropic offscreen stream cancelled", anthropicCancelled === true, String(anthropicCancelled));

if (runFirstByte) {
  console.log("Running first-byte-delay test (35s)...");
  await setStub({ mode: "stream", delayMs: 35000, frames: ["late"] });
  const late = await options.evaluate(`
    (async () => {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-first-byte', messages: [], stream: true
      });
      const out = [];
      for await (const chunk of stream) out.push(chunk);
      return out.map(c => c?.choices?.[0]?.delta?.content || '').join('');
    })()
  `);
  check("first-byte delay completes via offscreen", late === "late", late);
}

if (runLong) {
  const durationMs = 6 * 60 * 1000;
  console.log(`Running long stream test (${durationMs / 60000} min)...`);
  await setStub({ mode: "long", durationMs, intervalMs: 1000, frames: ["."] });
  const started = Date.now();
  const result = await options.evaluate(`
    (async () => {
      const stream = await self.__conversation.chat.completions.create({
        model: 'mock-slow', messages: [], stream: true
      });
      let count = 0;
      for await (const chunk of stream) count += 1;
      return count;
    })()
  `);
  const elapsed = Date.now() - started;
  check("long stream > 5 minutes", elapsed > 5 * 60 * 1000 && result > 0, `elapsed=${elapsed} chunks=${result}`);
}

try {
  await swCdp.evaluate("chrome.offscreen.closeDocument().then(() => 'closed').catch(e => 'ERR:' + e.message)");
} catch {
  // Ignore cleanup errors.
}
options.close();
offscreen.close();
swCdp.close();

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All browser protocol tests passed.");
}

// Installed once in the offscreen document.
function installStub() {
  self.__stubConfig = {};
  self.__stubInstalled = true;
  self.fetch = async (url, opts = {}) => {
    const config = self.__stubConfig || {};
    self.__lastRequest = { url, headers: opts.headers || {}, body: opts.body };
    if (config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }
    if (config.mode === "error") {
      return makeResponse(JSON.stringify({ error: { message: "mock rate limit" } }), 429, {
        "content-type": "application/json",
        "retry-after": "2",
        "x-request-id": "stub-429"
      }, url);
    }
    if (config.mode === "json") {
      const body = config.anthropic
        ? { id: "msg_mock", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }
        : { ok: true, url };
      return makeResponse(JSON.stringify(body), 200, {
        "content-type": "application/json",
        "x-request-id": "stub-json"
      }, url);
    }

    const encoder = new TextEncoder();
    const frames = config.frames || ["he", "llo", " world"];
    const interval = config.intervalMs || 40;
    const durationMs = config.durationMs || 0;
    const endless = config.mode === "endless" || config.mode === "long";
    let sent = 0;
    let timer = null;

    const stream = new ReadableStream({
      start(controller) {
        if (opts.signal) {
          const onAbort = () => {
            if (timer) clearInterval(timer);
            self.__stubCancelled = true;
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // Ignore.
            }
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }

        const endChunk = config.anthropic
          ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          : "data: [DONE]\n\n";
        const startedAt = Date.now();
        timer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          if (durationMs && elapsed >= durationMs) {
            controller.enqueue(encoder.encode(endChunk));
            clearInterval(timer);
            controller.close();
            return;
          }
          if (!endless && !durationMs && sent >= frames.length) {
            controller.enqueue(encoder.encode(endChunk));
            clearInterval(timer);
            controller.close();
            return;
          }
          const text = frames[sent % frames.length];
          sent += 1;
          let chunk;
          if (config.anthropic) {
            chunk = "event: content_block_delta\ndata: " + JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text }
            }) + "\n\n";
          } else if (config.responses) {
            chunk = "data: " + JSON.stringify({ type: "response.output_text.delta", delta: text }) + "\n\n";
          } else {
            chunk = "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n";
          }
          controller.enqueue(encoder.encode(chunk));
        }, interval);
      },
      cancel() {
        if (timer) clearInterval(timer);
        self.__stubCancelled = true;
      }
    });

    return makeResponse(stream, 200, {
      "content-type": "text/event-stream",
      "x-request-id": "stub-stream"
    }, url);
  };

  function makeResponse(body, status, headers, url) {
    const response = new Response(body, { status, headers });
    try {
      Object.defineProperty(response, "url", { value: url });
    } catch {
      // Ignore.
    }
    return response;
  }
}

// Runs in the offscreen document for each scenario.
function setStubConfig(config) {
  self.__stubConfig = config;
  self.__stubCancelled = false;
  return "configured";
}
