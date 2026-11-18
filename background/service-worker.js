import {
  buildEndpoints,
  byteLength,
  DEFAULT_MAX_BODY_BYTES,
  endpointFor,
  isOriginAllowed,
  isValidRequestId,
  isValidSessionId,
  providerBaseUrl,
  sanitizeResponseHeaders,
  truncateText,
  validateRequestBody
} from "../lib/validation.js";

const PROTOCOL_VERSION = 1;
const PORT_NAME = "opencode-bridge";
const RELAY_PORT_NAME = "opencode-bridge-relay";
const KEEPALIVE_ALARM = "opencode-bridge-keepalive";
const CONNECT_TIMEOUT_MS = 25000;
const MAX_ERROR_BODY = 65536;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_EXTERNAL_PORTS = 32;
const ANTHROPIC_VERSION = "2023-06-01";
const OFFSCREEN_PORT_NAME = "opencode-offscreen";
const OFFSCREEN_CONNECT_TIMEOUT_MS = 5000;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

const DEFAULTS = {
  provider: "console",
  customBaseUrl: "",
  apiKey: "",
  allowedOrigins: [],
  clientUserAgent: `opencode-bridge/${EXTENSION_VERSION}`,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  maxConcurrent: 4,
  maxPerOrigin: 2
};

/** @type {Map<chrome.runtime.Port, {origin: string|null, requests: Map<string, any>}>} */
const portStates = new Map();

let activeRequests = 0;
const activePerOrigin = new Map();

/** @type {chrome.runtime.Port|null} */
let offscreenPort = null;
let offscreenReady = false;
// Safari (and other non-Chrome browsers) do not expose chrome.offscreen.
let offscreenUnavailable = false;
let offscreenWarned = false;
/** @type {Promise<chrome.runtime.Port>|null} */
let offscreenEnsurePromise = null;
/** @type {Array<{resolve: Function, reject: Function, timer: any}>} */
let offscreenWaiters = [];
/** @type {Map<string, {pagePort: chrome.runtime.Port, pageRequestId: string, request: any, resolve: Function}>} */
const offscreenRequests = new Map();

// ---------------------------------------------------------------------------
// Startup and configuration
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function restrictStorage() {
  try {
    if (chrome.storage.local.setAccessLevel) {
      await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch {
    // Older Chrome builds may not support this. It is best-effort hardening.
  }
}

async function refreshUaRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    return;
  }

  let host = null;
  let userAgent = "";
  try {
    const settings = await getSettings();
    userAgent = String(settings.clientUserAgent || "").trim();
    const baseUrl = providerBaseUrl(settings.provider, settings.customBaseUrl);
    host = new URL(baseUrl).hostname;
  } catch {
    return;
  }

  const addRules = [];
  if (userAgent && host) {
    addRules.push({
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "user-agent",
            operation: "set",
            value: userAgent
          }
        ]
      },
      condition: {
        requestDomains: [host],
        // Service worker fetches do not originate from a tab.
        tabIds: [-1]
      }
    });
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules
    });
  } catch (error) {
    // Do not log request data or credentials here.
    console.warn("[OpenCode Bridge] Could not update the User-Agent rule:", error?.message || error);
  }
}

async function init() {
  const stored = await chrome.storage.local.get(null);
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!(key in stored)) {
      missing[key] = value;
    }
  }
  if (Object.keys(missing).length) {
    await chrome.storage.local.set(missing);
  }
  await restrictStorage();
  await refreshUaRule();
}

function reportInitError(error) {
  console.warn("[OpenCode Bridge] Initialization failed:", error?.message || error);
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage()?.catch?.(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void init().catch(reportInitError);
});
chrome.runtime.onStartup.addListener(() => {
  void init().catch(reportInitError);
});
void init().catch(reportInitError);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.provider || changes.customBaseUrl || changes.clientUserAgent) {
    void refreshUaRule();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (activeRequests === 0) {
    try {
      chrome.alarms.clear(KEEPALIVE_ALARM)?.catch?.(() => {});
    } catch {
      // Best effort.
    }
    return;
  }
  // Calling an extension API resets the service worker idle timer.
  try {
    chrome.runtime.getPlatformInfo()?.catch?.(() => {});
  } catch {
    // Best effort.
  }
});

function updateKeepAlive() {
  try {
    if (activeRequests > 0) {
      const created = chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      created?.catch?.(() => {});
    } else {
      const cleared = chrome.alarms.clear(KEEPALIVE_ALARM);
      cleared?.catch?.(() => {});
    }
  } catch {
    // Alarms are best-effort; the SDK also sends heartbeats.
  }
}

// ---------------------------------------------------------------------------
// Offscreen inference executor
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== OFFSCREEN_PORT_NAME) {
    return;
  }

  offscreenPort = port;
  offscreenReady = false;

  port.onMessage.addListener((message) => {
    handleOffscreenMessage(message);
  });

  port.onDisconnect.addListener(() => {
    if (offscreenPort !== port) {
      return;
    }
    offscreenPort = null;
    offscreenReady = false;
    handleOffscreenDisconnect();
  });
});

function resolveOffscreenWaiters(port) {
  const waiters = offscreenWaiters;
  offscreenWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(port);
  }
}

function ensureOffscreenPort() {
  if (offscreenUnavailable) {
    return Promise.reject(new Error("Offscreen documents are unavailable in this browser."));
  }
  if (offscreenPort) {
    if (offscreenReady) {
      return Promise.resolve(offscreenPort);
    }
    if (!offscreenEnsurePromise) {
      offscreenEnsurePromise = waitForOffscreenPort(OFFSCREEN_CONNECT_TIMEOUT_MS)
        .catch((error) => {
          offscreenPort = null;
          offscreenReady = false;
          throw error;
        })
        .finally(() => {
          offscreenEnsurePromise = null;
        });
    }
    return offscreenEnsurePromise;
  }

  if (!offscreenEnsurePromise) {
    offscreenEnsurePromise = ensureOffscreenPortInner().finally(() => {
      offscreenEnsurePromise = null;
    });
  }
  return offscreenEnsurePromise;
}

async function ensureOffscreenPortInner() {
  const created = await ensureOffscreenDocument();

  if (created) {
    try {
      return await waitForOffscreenPort(OFFSCREEN_CONNECT_TIMEOUT_MS);
    } catch {
      // Fall through to a clean recreate.
    }
  }

  // An offscreen document can survive a service worker restart while its port
  // does not. In that case, recreate it so it connects to this worker instance.
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Ignore; it may already be gone.
  }
  await createOffscreenDocument();
  return waitForOffscreenPort(OFFSCREEN_CONNECT_TIMEOUT_MS);
}

function waitForOffscreenPort(timeoutMs) {
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      const index = offscreenWaiters.indexOf(waiter);
      if (index !== -1) {
        offscreenWaiters.splice(index, 1);
      }
      reject(new Error("The offscreen executor did not connect in time."));
    }, timeoutMs);
    offscreenWaiters.push(waiter);
  });
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
      if (contexts.length > 0) {
        return false;
      }
    } catch {
      // Fall through to createDocument; some Chrome builds may not expose
      // getContexts or may reject the context type.
    }
  }

  try {
    await createOffscreenDocument();
    return true;
  } catch (error) {
    const message = error?.message || "";
    if (/single offscreen|already exists|more than one offscreen/i.test(message)) {
      return false;
    }
    throw error;
  }
}

function createOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    offscreenUnavailable = true;
    return Promise.reject(new Error("chrome.offscreen is not available in this browser."));
  }
  // Chrome has no "network" reason. WORKERS is the closest documented
  // long-lived reason; this document performs the actual fetch/stream work.
  return chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run long-lived inference requests outside the service worker request lifetime."
  });
}

function handleOffscreenDisconnect() {
  const error = new Error("The offscreen inference executor disconnected. The request was not resumed.");

  for (const [id, entry] of offscreenRequests) {
    sendError(entry.pagePort, entry.pageRequestId, "OFFSCREEN_DISCONNECTED", error.message);
    offscreenRequests.delete(id);
    entry.resolve();
  }

  const waiters = offscreenWaiters;
  offscreenWaiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function handleOffscreenMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "offscreen-ready") {
    if (offscreenPort) {
      offscreenReady = true;
      resolveOffscreenWaiters(offscreenPort);
    }
    return;
  }
  if (message.type === "pong") {
    return;
  }

  const entry = message.id ? offscreenRequests.get(message.id) : null;
  if (!entry) {
    return;
  }

  const pageRequestId = entry.pageRequestId;

  if (message.type === "accepted") {
    const forwarded = sendToPort(entry.pagePort, {
      type: "accepted",
      requestId: pageRequestId,
      status: message.status,
      headers: message.headers || {}
    });
    if (!forwarded) cancelOffscreenForClosedPage(message.id);
  } else if (message.type === "chunk") {
    const forwarded = sendToPort(entry.pagePort, {
      type: "chunk",
      requestId: pageRequestId,
      data: message.data
    });
    if (!forwarded) cancelOffscreenForClosedPage(message.id);
  } else if (message.type === "response") {
    const forwarded = sendToPort(entry.pagePort, {
      type: "response",
      requestId: pageRequestId,
      status: message.status,
      headers: message.headers || {},
      body: message.body ?? ""
    });
    if (!forwarded) cancelOffscreenForClosedPage(message.id);
  } else if (message.type === "done") {
    sendToPort(entry.pagePort, { type: "done", requestId: pageRequestId });
    finishOffscreenRequest(message.id);
  } else if (message.type === "cancelled") {
    sendToPort(entry.pagePort, { type: "cancelled", requestId: pageRequestId });
    finishOffscreenRequest(message.id);
  } else if (message.type === "error") {
    const details = message.error && typeof message.error === "object" ? message.error : {};
    sendError(
      entry.pagePort,
      pageRequestId,
      details.code || "OFFSCREEN_ERROR",
      details.message || "The offscreen request failed.",
      details
    );
    finishOffscreenRequest(message.id);
  }
}

function finishOffscreenRequest(id) {
  const entry = offscreenRequests.get(id);
  if (!entry) {
    return;
  }
  offscreenRequests.delete(id);
  entry.resolve();
}

function cancelOffscreenForClosedPage(id) {
  try {
    offscreenPort?.postMessage({ type: "cancel", id });
  } catch {
    // Ignore.
  }
  finishOffscreenRequest(id);
}

// ---------------------------------------------------------------------------
// External port lifecycle
// ---------------------------------------------------------------------------

const pendingExternalPorts = new Set();

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== PORT_NAME || portStates.size + pendingExternalPorts.size >= MAX_EXTERNAL_PORTS) {
    port.disconnect();
    return;
  }

  pendingExternalPorts.add(port);
  port.onDisconnect.addListener(() => {
    pendingExternalPorts.delete(port);
  });

  void (async () => {
    const validation = await validatePortOrigin(port).catch(() => ({ ok: false }));
    if (!pendingExternalPorts.has(port)) {
      return;
    }
    pendingExternalPorts.delete(port);

    if (!validation.ok) {
      sendToPort(port, {
        type: "fatal",
        error: {
          code: "ORIGIN_DENIED",
          message: "This origin is not allowed. Add it to the extension options first."
        }
      });
      port.disconnect();
      return;
    }

    attachBridgePort(port, validation.origin);
  })();
});

// Trusted extension pages (options/debug harness) may use the same protocol.
// Web pages must still pass the runtime Origin allowlist above.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === RELAY_PORT_NAME) {
    handleRelayConnect(port);
    return;
  }

  if (port.name !== PORT_NAME) {
    return;
  }

  const sender = port.sender;
  const expectedOrigin = `chrome-extension://${chrome.runtime.id}`;
  if (!sender || sender.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  if (!sender.url || !sender.url.startsWith(`${expectedOrigin}/`)) {
    port.disconnect();
    return;
  }
  if (portStates.size >= MAX_EXTERNAL_PORTS) {
    port.disconnect();
    return;
  }

  attachBridgePort(port, expectedOrigin);
});

// Content scripts relay Safari web pages through an internal port. They are
// identified by sender.id, but the page origin must still pass the runtime
// allowlist — the relay is not an authorization bypass.
const pendingRelayPorts = new Set();

function handleRelayConnect(port) {
  const sender = port.sender;
  if (!sender || sender.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  if (!sender.url || !/^https?:\/\//.test(sender.url)) {
    port.disconnect();
    return;
  }
  if (portStates.size + pendingRelayPorts.size >= MAX_EXTERNAL_PORTS) {
    port.disconnect();
    return;
  }

  pendingRelayPorts.add(port);
  port.onDisconnect.addListener(() => {
    pendingRelayPorts.delete(port);
  });

  void (async () => {
    const validation = await validatePortOrigin(port).catch(() => ({ ok: false }));
    if (!pendingRelayPorts.has(port)) {
      return;
    }
    pendingRelayPorts.delete(port);

    if (!validation.ok) {
      sendToPort(port, {
        type: "fatal",
        error: {
          code: "ORIGIN_DENIED",
          message: "This origin is not allowed. Add it to the extension options first."
        }
      });
      port.disconnect();
      return;
    }

    attachBridgePort(port, validation.origin);
  })();
}

function attachBridgePort(port, origin) {
  if (portStates.has(port)) {
    return;
  }

  const state = {
    origin,
    requests: new Map()
  };
  portStates.set(port, state);

  port.onDisconnect.addListener(() => {
    for (const request of state.requests.values()) {
      request.cancelled = true;
      request.controller.abort();
    }

    for (const [id, entry] of offscreenRequests) {
      if (entry.pagePort !== port) {
        continue;
      }
      entry.request.cancelled = true;
      try {
        offscreenPort?.postMessage({ type: "cancel", id });
      } catch {
        // Ignore; the offscreen executor may be gone.
      }
      offscreenRequests.delete(id);
      entry.resolve();
    }

    state.requests.clear();
    portStates.delete(port);
    updateKeepAlive();
  });

  sendHello(port);
  port.onMessage.addListener((message) => {
    handleMessage(port, state, message);
  });
}

async function validatePortOrigin(port) {
  const sender = port.sender;
  if (!sender) {
    return { ok: false };
  }

  let origin = sender.origin;
  if (typeof origin !== "string" || !origin || origin === "null") {
    // Some Safari versions leave sender.origin empty for content-script
    // ports. sender.url is browser-provided, so deriving the origin from it
    // is equivalent; a page cannot spoof either field.
    origin = null;
  } else if (!/^https?:\/\//.test(origin)) {
    return { ok: false };
  }

  let urlOrigin = null;
  if (sender.url) {
    try {
      urlOrigin = new URL(sender.url).origin;
    } catch {
      return { ok: false };
    }
  }

  if (!origin) {
    origin = urlOrigin;
  }
  if (!origin || !/^https?:\/\//.test(origin)) {
    return { ok: false };
  }
  if (urlOrigin && urlOrigin !== origin) {
    return { ok: false };
  }

  const settings = await getSettings();
  if (!isOriginAllowed(origin, settings.allowedOrigins)) {
    return { ok: false };
  }

  return { ok: true, origin };
}

function sendHello(port) {
  sendToPort(port, {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId: chrome.runtime.id
  });
}

function sendToPort(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function sendError(port, requestId, code, message, details = {}) {
  sendToPort(port, {
    type: "error",
    requestId: requestId || null,
    error: {
      code,
      message,
      ...details
    }
  });
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleMessage(port, state, message) {
  if (!message || typeof message !== "object") {
    sendError(port, null, "BAD_MESSAGE", "Message must be an object.");
    return;
  }

  if (message.type === "hello") {
    sendHello(port);
    return;
  }

  if (message.type === "ping") {
    sendToPort(port, { type: "pong" });
    return;
  }

  if (message.type === "cancel") {
    cancelRequest(state, message.requestId);
    return;
  }

  if (message.type === "request") {
    void handleRequest(port, state, message);
    return;
  }

  sendError(port, message.requestId || null, "BAD_MESSAGE", "Unknown message type.");
}

function cancelRequest(state, requestId) {
  if (!isValidRequestId(requestId)) {
    return;
  }
  const request = state.requests.get(requestId);
  if (!request) {
    return;
  }
  request.cancelled = true;
  if (request.internalId) {
    try {
      offscreenPort?.postMessage({ type: "cancel", id: request.internalId });
    } catch {
      // Ignore; the offscreen executor may be gone.
    }
  } else {
    request.controller.abort();
  }
}

async function handleRequest(port, state, message) {
  const requestId = message.requestId;
  if (!isValidRequestId(requestId)) {
    sendError(port, requestId || null, "BAD_REQUEST_ID", "requestId must be 1-128 safe characters.");
    return;
  }
  if (state.requests.has(requestId)) {
    sendError(port, requestId, "DUPLICATE_REQUEST_ID", "requestId is already in use on this port.");
    return;
  }

  const api = message.api;
  const body = message.body;
  const validation = validateRequestBody(api, body);
  if (!validation.ok) {
    sendError(port, requestId, "BAD_REQUEST", validation.error);
    return;
  }

  let sessionId = message.sessionId;
  if (sessionId !== undefined && sessionId !== null && !isValidSessionId(sessionId)) {
    sendError(port, requestId, "BAD_SESSION_ID", "sessionId must be 1-128 safe characters.");
    return;
  }
  if (!sessionId) {
    sessionId = makeSessionId();
  }

  let bodySize = 0;
  if (api !== "models.list") {
    try {
      bodySize = byteLength(body);
    } catch {
      sendError(port, requestId, "BAD_BODY", "Request body is not JSON-serializable.");
      return;
    }
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    sendError(port, requestId, "INTERNAL_ERROR", error?.message || "Could not read extension settings.");
    return;
  }

  // The page may have disconnected while storage was being read.
  if (portStates.get(port) !== state) {
    return;
  }

  if (bodySize > settings.maxBodyBytes) {
    sendError(port, requestId, "BODY_TOO_LARGE", `Request body exceeds the configured limit (${settings.maxBodyBytes} bytes).`);
    return;
  }

  const apiKey = String(settings.apiKey || "").trim();
  if (!apiKey) {
    sendError(port, requestId, "AUTH_MISSING", "No API key is configured. Open the extension options and save a key.");
    return;
  }

  if (!acquireSlot(state.origin, settings)) {
    sendError(port, requestId, "CONCURRENCY_LIMIT", "Too many concurrent requests. Try again later.");
    return;
  }

  const controller = new AbortController();
  const request = {
    requestId,
    origin: state.origin,
    controller,
    internalId: null,
    cancelled: false
  };
  state.requests.set(requestId, request);

  try {
    let handledByOffscreen = false;
    const shouldUseOffscreen = api !== "models.list";

    if (shouldUseOffscreen) {
      handledByOffscreen = await runViaOffscreen({
        port,
        request,
        requestId,
        api,
        body,
        sessionId,
        settings,
        apiKey
      });
    }

    if (!handledByOffscreen) {
      await runRequest({
        port,
        state,
        request,
        requestId,
        api,
        body,
        sessionId,
        settings,
        apiKey
      });
    }
  } catch (error) {
    if (request.cancelled) {
      sendToPort(port, { type: "cancelled", requestId });
    } else {
      const code = /base url|provider|unknown provider/i.test(error?.message || "")
        ? "CONFIG_ERROR"
        : "INTERNAL_ERROR";
      sendError(port, requestId, code, error?.message || "Unexpected bridge error.");
    }
  } finally {
    state.requests.delete(requestId);
    releaseSlot(state.origin);
  }
}

function acquireSlot(origin, settings) {
  const maxConcurrent = Number(settings.maxConcurrent) || DEFAULTS.maxConcurrent;
  const maxPerOrigin = Number(settings.maxPerOrigin) || DEFAULTS.maxPerOrigin;
  const perOrigin = activePerOrigin.get(origin) || 0;

  if (activeRequests >= maxConcurrent || perOrigin >= maxPerOrigin) {
    return false;
  }

  activeRequests += 1;
  activePerOrigin.set(origin, perOrigin + 1);
  updateKeepAlive();
  return true;
}

function releaseSlot(origin) {
  activeRequests = Math.max(0, activeRequests - 1);
  const perOrigin = activePerOrigin.get(origin) || 0;
  if (perOrigin <= 1) {
    activePerOrigin.delete(origin);
  } else {
    activePerOrigin.set(origin, perOrigin - 1);
  }
  updateKeepAlive();
}

function buildUpstreamHeaders({ api, method, apiKey, sessionId, wantsStream }) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: wantsStream ? "text/event-stream" : "application/json"
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
  }
  if (api !== "models.list") {
    headers["x-opencode-session"] = sessionId;
  }
  if (api === "anthropic.messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  return headers;
}

async function runViaOffscreen({ port, request, requestId, api, body, sessionId, settings, apiKey }) {
  const baseUrl = providerBaseUrl(settings.provider, settings.customBaseUrl);
  const endpoints = buildEndpoints(baseUrl);
  const url = endpointFor(api, endpoints);
  const baseOrigin = new URL(baseUrl).origin;

  let offscreen;
  try {
    offscreen = await ensureOffscreenPort();
  } catch (error) {
    if (!offscreenWarned) {
      offscreenWarned = true;
      console.warn(
        "[OpenCode Bridge] Offscreen stream executor unavailable; falling back to the service worker:",
        error?.message || error
      );
    }
    return false;
  }

  const internalId = makeInternalId();
  request.internalId = internalId;

  const wantsStream = body?.stream === true;
  const headers = buildUpstreamHeaders({
    api,
    method: "POST",
    apiKey,
    sessionId,
    wantsStream
  });

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  offscreenRequests.set(internalId, {
    pagePort: port,
    pageRequestId: requestId,
    request,
    resolve: resolveDone
  });

  if (request.cancelled) {
    try {
      offscreen.postMessage({ type: "cancel", id: internalId });
    } catch {
      // Ignore.
    }
    finishOffscreenRequest(internalId);
    sendToPort(port, { type: "cancelled", requestId });
    return true;
  }

  try {
    offscreen.postMessage({
      type: "start",
      id: internalId,
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      stream: wantsStream,
      baseOrigin,
      maxResponseBytes: MAX_RESPONSE_BYTES
    });
  } catch (error) {
    offscreenRequests.delete(internalId);
    resolveDone();
    sendError(port, requestId, "OFFSCREEN_ERROR", error?.message || "Could not start the offscreen stream.");
    return true;
  }

  await done;
  return true;
}

function makeInternalId() {
  if (globalThis.crypto?.randomUUID) {
    return `off_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `off_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Upstream request
// ---------------------------------------------------------------------------

async function runRequest({ port, state, request, requestId, api, body, sessionId, settings, apiKey }) {
  const baseUrl = providerBaseUrl(settings.provider, settings.customBaseUrl);
  const endpoints = buildEndpoints(baseUrl);
  const url = endpointFor(api, endpoints);
  const method = api === "models.list" ? "GET" : "POST";

  const headers = buildUpstreamHeaders({
    api,
    method,
    apiKey,
    sessionId,
    wantsStream: body?.stream === true
  });

  const payload = method === "POST" ? JSON.stringify(body) : undefined;
  let timedOut = false;
  const connectTimer = setTimeout(() => {
    timedOut = true;
    request.controller.abort();
  }, CONNECT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: request.controller.signal,
      redirect: "error",
      cache: "no-store"
    });
  } catch (error) {
    if (request.cancelled) {
      sendToPort(port, { type: "cancelled", requestId });
    } else if (timedOut) {
      sendError(port, requestId, "CONNECT_TIMEOUT", "The upstream API did not respond in time.");
    } else {
      sendError(port, requestId, "NETWORK_ERROR", error?.message || "Network request failed.");
    }
    return;
  } finally {
    clearTimeout(connectTimer);
  }

  try {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== new URL(baseUrl).origin) {
      sendError(port, requestId, "UNEXPECTED_REDIRECT", "The upstream response came from an unexpected origin.");
      return;
    }
  } catch {
    sendError(port, requestId, "UNEXPECTED_REDIRECT", "The upstream response URL could not be validated.");
    return;
  }

  const responseHeaders = sanitizeResponseHeaders(response.headers);

  if (!response.ok) {
    let text = "";
    try {
      const result = await readTextLimited(response, MAX_ERROR_BODY);
      text = result.text;
    } catch {
      // Keep the HTTP status even if the error body cannot be read.
    }
    sendError(port, requestId, "UPSTREAM_HTTP_ERROR", `Upstream returned HTTP ${response.status}.`, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: truncateText(text, MAX_ERROR_BODY)
    });
    return;
  }

  sendToPort(port, {
    type: "accepted",
    requestId,
    status: response.status,
    headers: responseHeaders
  });

  const wantsStream = api !== "models.list" && body?.stream === true;

  if (!wantsStream) {
    let result;
    try {
      result = await readTextLimited(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (request.cancelled) {
        sendToPort(port, { type: "cancelled", requestId });
      } else {
        sendError(port, requestId, "RESPONSE_READ_ERROR", error?.message || "Could not read the upstream response.");
      }
      return;
    }

    if (result.truncated) {
      sendError(port, requestId, "RESPONSE_TOO_LARGE", "The upstream response exceeded the bridge limit.", {
        status: response.status,
        headers: responseHeaders,
        body: truncateText(result.text, MAX_ERROR_BODY)
      });
      return;
    }

    sendToPort(port, {
      type: "response",
      requestId,
      status: response.status,
      headers: responseHeaders,
      body: result.text
    });
    sendToPort(port, { type: "done", requestId });
    return;
  }

  if (!response.body) {
    const result = await readTextLimited(response, MAX_RESPONSE_BYTES);
    if (result.truncated) {
      sendError(port, requestId, "RESPONSE_TOO_LARGE", "The upstream response exceeded the bridge limit.", {
        status: response.status,
        headers: responseHeaders
      });
      return;
    }
    if (result.text) {
      sendToPort(port, { type: "chunk", requestId, data: result.text });
    }
    sendToPort(port, { type: "done", requestId });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let responseBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        responseBytes += value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Ignore.
          }
          sendError(port, requestId, "RESPONSE_TOO_LARGE", "The upstream stream exceeded the bridge limit.", {
            status: response.status,
            headers: responseHeaders
          });
          return;
        }
        const text = decoder.decode(value, { stream: true });
        if (text) {
          sendToPort(port, { type: "chunk", requestId, data: text });
        }
      }
    }

    const tail = decoder.decode();
    if (tail) {
      sendToPort(port, { type: "chunk", requestId, data: tail });
    }
    sendToPort(port, { type: "done", requestId });
  } catch (error) {
    if (request.cancelled) {
      sendToPort(port, { type: "cancelled", requestId });
    } else if (timedOut) {
      sendError(port, requestId, "CONNECT_TIMEOUT", "The upstream API did not respond in time.");
    } else {
      sendError(port, requestId, "STREAM_ERROR", error?.message || "The upstream stream ended unexpectedly.");
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

function makeSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return `ses_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `ses_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) {
    return { text: "", truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        const remaining = value.byteLength - (total - maxBytes);
        if (remaining > 0) {
          text += decoder.decode(value.slice(0, remaining), { stream: true });
        }
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // Ignore.
        }
        break;
      }

      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, truncated };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}
