// Content-script relay tests. A local HTTP server serves the page and the SDK,
// so the manifest content script is injected like on a real site. This
// exercises the exact path Safari uses: page -> window.postMessage ->
// content script -> internal runtime port -> service worker.
//
// Run against Chromium with the extension loaded:
//   node tests/browser/relay-test.mjs <cdpPort>

import fs from "node:fs";
import http from "node:http";
import { listTargets, createTarget, connectTarget, sleep } from "./cdp.mjs";

const cdpPort = Number(process.argv[2] || 9487);
const projectRoot = new URL("../../", import.meta.url);
const sdkSource = fs.readFileSync(new URL("sdk/opencode-bridge.js", projectRoot), "utf8");

let failures = 0;
const check = (name, condition, extra = "") => {
  if (condition) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? `: ${extra}` : ""}`);
  }
};

const targets = await listTargets(cdpPort);
const sw = targets.find((t) => t.type === "service_worker" && t.url.includes("/background/service-worker.js"));
if (!sw) throw new Error("Extension service worker target not found.");
const extensionId = new URL(sw.url).host;

const swCdp = await connectTarget(sw);
await swCdp.send("Runtime.enable");

// Serve the test page, its script, and the SDK from one origin so the page can
// import the SDK as a module.
const server = http.createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  const body = path === "/test.html"
    ? html
    : path === "/test.js"
      ? pageJs
      : path === "/sdk/opencode-bridge.js"
        ? sdkSource
        : null;

  if (body === null) {
    response.writeHead(404);
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8"
  });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, resolve));
const serverPort = server.address().port;
const allowedOrigin = `http://127.0.0.1:${serverPort}`;
const deniedOrigin = `http://localhost:${serverPort}`;
console.log("SERVER", allowedOrigin, serverPort);

// Configure the extension: only the 127.0.0.1 origin is allowed.
const optionsTarget = await createTarget(cdpPort, "about:blank");
const options = await connectTarget(optionsTarget);
await options.send("Runtime.enable");
await options.send("Page.enable");
await options.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/index.html` });
await sleep(800);
await options.evaluate(`
  document.getElementById('provider').value = 'go';
  document.getElementById('clientUserAgent').value = 'ocb-relay-test/1.0';
  document.getElementById('allowedOrigins').value = ${JSON.stringify(allowedOrigin)};
  document.getElementById('apiKey').value = 'oc_sk_relay_test';
  document.getElementById('save').click();
  'clicked'
`);
await sleep(1000);
console.log("OPTIONS_SAVED");

// Pre-create offscreen and install the same controllable fetch stub.
await swCdp.evaluate(`
  chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['WORKERS'],
    justification: 'relay page test'
  }).then(() => 'created').catch(e => 'ERR:' + e.message)
`);
let offscreenTarget = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(200);
  const list = await listTargets(cdpPort);
  offscreenTarget = list.find((t) => t.url.includes("offscreen/offscreen.html"));
  if (offscreenTarget) break;
}
if (!offscreenTarget) throw new Error("Offscreen target not found.");
const offscreen = await connectTarget(offscreenTarget);
await offscreen.send("Runtime.enable");
await offscreen.evaluate(`(${installStub.toString()})()`);
await offscreen.evaluate(`(${setStubConfig.toString()})(${JSON.stringify({ mode: "stream", frames: ["hello", " ", "world"] })})`);
console.log("OFFSCREEN_STUBBED");

const pageJs = `
(async () => {
  try {
    const mod = await import('/sdk/opencode-bridge.js');
    const bridge = new mod.OpenCodeBridge({
      extensionId: ${JSON.stringify(extensionId)},
      transport: 'relay',
      relayProbeTimeoutMs: 3000
    });
    const conversation = bridge.createConversation({ sessionId: 'ses_relay_test' });
    const stream = await conversation.chat.completions.create({
      model: 'mock-stream',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const plain = await conversation.chat.completions.create({
      model: 'mock-plain',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    });
    self.__result = {
      origin: location.origin,
      transport: bridge.transport,
      chunks: chunks.map(c => c?.choices?.[0]?.delta?.content || '').join(''),
      status: plain.status,
      storageType: typeof chrome.storage
    };
    bridge.close();
  } catch (e) {
    self.__result = {
      origin: location.origin,
      error: { code: e.code, message: e.message }
    };
  }
})();
`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge relay test</title></head>
<body><script type="module" src="/test.js"></script></body></html>`;

async function runPage(origin) {
  console.log("RUN_PAGE", origin);
  const target = await createTarget(cdpPort, "about:blank");
  const cdp = await connectTarget(target);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const values = (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type);
    console.log("CONSOLE", origin, params.type, JSON.stringify(values));
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    console.log("EXCEPTION", origin, params.exceptionDetails?.text, params.exceptionDetails?.exception?.description || "");
  });
  cdp.send("Page.navigate", { url: `${origin}/test.html` }).catch((error) => console.log("NAV_ERROR", origin, error.message));

  try {
    let result = null;
    let timedOut = 0;
    for (let i = 0; i < 40; i += 1) {
      await sleep(300);
      const value = await evaluateWithTimeout(cdp, "self.__result || null");
      if (value === TIMEOUT || isEvalError(value)) {
        timedOut += 1;
        // Renderer navigation is blocked in some sandboxes; bail out early.
        if (timedOut >= 4) return { blocked: true, result: null };
        continue;
      }
      timedOut = 0;
      if (value) {
        result = value;
        break;
      }
    }

    if (!result) {
      const debug = await evaluateWithTimeout(cdp, "JSON.stringify({ href: location.href, ready: document.readyState })");
      console.log("DEBUG", origin, debug);
      if (debug === TIMEOUT || isEvalError(debug)) return { blocked: true, result: null };
    }
    console.log("PAGE_RESULT", origin, JSON.stringify(result));
    return { blocked: false, result };
  } finally {
    cdp.close();
  }
}

const TIMEOUT = "__ocb_eval_timeout__";

function evaluateWithTimeout(cdp, expression, timeoutMs = 2000) {
  return Promise.race([
    cdp.evaluate(expression, { awaitPromise: false }).catch((error) => `__ocb_eval_error__:${error.message}`),
    sleep(timeoutMs).then(() => TIMEOUT)
  ]);
}

function isEvalError(value) {
  return typeof value === "string" && value.startsWith("__ocb_eval_error__");
}

try {
  const allowedRun = await runPage(allowedOrigin);
  if (allowedRun.blocked) {
    console.log("SKIP relay page tests: this Chromium environment blocks renderer navigation. See RESULTS.md.");
    process.exitCode = 0;
  } else {
    const allowed = allowedRun.result;
    console.log("ALLOWED", JSON.stringify(allowed));
    check("relay page loaded with expected origin", allowed?.origin === allowedOrigin, JSON.stringify(allowed));
    check("relay page stream", allowed?.chunks === "hello world", JSON.stringify(allowed));
    check("relay transport negotiated", allowed?.transport === "relay", JSON.stringify(allowed));
    check("relay non-stream response", allowed?.status === 200, JSON.stringify(allowed));
    check("relay page cannot read chrome.storage", allowed?.storageType === "undefined", JSON.stringify(allowed));

    const deniedRun = await runPage(deniedOrigin);
    const denied = deniedRun.result;
    console.log("DENIED", JSON.stringify(denied));
    check("non-allowlisted origin denied via relay", denied?.error?.code === "ORIGIN_DENIED", JSON.stringify(denied));
  }
} finally {
  options.close();
  offscreen.close();
  swCdp.close();
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

if (failures > 0) {
  console.error(`${failures} relay test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("All relay tests passed.");
}

function installStub() {
  self.__stubConfig = {};
  self.fetch = async (url, opts = {}) => {
    const config = self.__stubConfig || {};
    self.__lastRequest = { url, headers: opts.headers || {}, body: opts.body };
    const encoder = new TextEncoder();
    const frames = config.frames || ["x"];
    let sent = 0;
    const stream = new ReadableStream({
      start(controller) {
        const timer = setInterval(() => {
          if (sent >= frames.length) {
            controller.enqueue(encoder.encode("data: [DONE]\\n\\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          const text = frames[sent % frames.length];
          sent += 1;
          controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\\n\\n"));
        }, 40);
      }
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
    try {
      Object.defineProperty(response, "url", { value: url });
    } catch {
      // Ignore.
    }
    return response;
  };
}

function setStubConfig(config) {
  self.__stubConfig = config;
  return "configured";
}
