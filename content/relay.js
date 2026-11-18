// OpenCode Bridge content-script relay.
//
// Safari web pages cannot reliably open a direct port to an extension. This
// script runs in the extension's content-script world and relays the SDK's
// port protocol between window.postMessage and a privileged runtime port.
//
// The relay holds no credentials, never reads extension storage, and performs
// no origin policy decisions. The service worker still validates the page
// origin against the runtime allowlist before attaching the port.

(() => {
  "use strict";

  const RELAY_MARKER = "__opencodeBridge";
  const RELAY_VERSION = 1;
  const RELAY_PORT_NAME = "opencode-bridge-relay";
  const INSTALL_MARK = "__opencodeBridgeRelayInstalled";

  if (globalThis[INSTALL_MARK]) {
    return;
  }
  globalThis[INSTALL_MARK] = true;

  const runtime = getRuntime();
  if (!runtime) {
    return;
  }

  /** @type {Map<string, {port: any, seq: number}>} */
  const ports = new Map();

  function getRuntime() {
    const candidates = [globalThis.browser?.runtime, globalThis.chrome?.runtime];
    for (const candidate of candidates) {
      if (candidate && typeof candidate.connect === "function") {
        return candidate;
      }
    }
    return null;
  }

  function pageOrigin() {
    return location.origin || "";
  }

  function postToPage(message) {
    try {
      window.postMessage(
        { [RELAY_MARKER]: RELAY_VERSION, source: "relay", ...message },
        pageOrigin() || "*"
      );
    } catch {
      // The page may be navigating away.
    }
  }

  function openPort(portId, initialPayload) {
    let entry = ports.get(portId);
    if (!entry) {
      let port;
      try {
        port = runtime.connect({ name: RELAY_PORT_NAME });
      } catch {
        postToPage({ kind: "close", portId });
        return;
      }

      entry = { port, seq: 0 };
      ports.set(portId, entry);

      port.onMessage.addListener((message) => {
        if (ports.get(portId) !== entry) {
          return;
        }
        if (message === null || typeof message !== "object") {
          return;
        }
        entry.seq += 1;
        postToPage({
          kind: "msg",
          portId,
          seq: entry.seq,
          payload: message
        });
      });

      port.onDisconnect.addListener(() => {
        if (ports.get(portId) !== entry) {
          return;
        }
        ports.delete(portId);
        postToPage({ kind: "close", portId });
      });
    }

    if (initialPayload && typeof initialPayload === "object") {
      try {
        entry.port.postMessage(initialPayload);
      } catch {
        // The service worker may have gone away; onDisconnect reports it.
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    if (event.origin !== pageOrigin()) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== "object" || data[RELAY_MARKER] !== RELAY_VERSION) {
      return;
    }
    // Only page-originated envelopes are forwarded. This also prevents the
    // relay's own replies (source: "relay"), echoed back by the same window,
    // from being forwarded to the service worker again.
    if (data.source !== "page") {
      return;
    }

    if (data.kind === "probe") {
      postToPage({ kind: "probe-ack", nonce: data.nonce });
      return;
    }

    if (typeof data.portId !== "string" || !data.portId) {
      return;
    }

    if (data.kind === "open") {
      openPort(data.portId, data.payload);
      return;
    }

    const entry = ports.get(data.portId);
    if (!entry) {
      return;
    }

    if (data.kind === "msg") {
      if (data.payload === undefined) {
        return;
      }
      try {
        entry.port.postMessage(data.payload);
      } catch {
        // onDisconnect reports the failure to the page.
      }
      return;
    }

    if (data.kind === "close") {
      ports.delete(data.portId);
      try {
        entry.port.disconnect();
      } catch {
        // Ignore.
      }
    }
  });

  window.addEventListener("pagehide", () => {
    for (const entry of ports.values()) {
      try {
        entry.port.disconnect();
      } catch {
        // Ignore.
      }
    }
    ports.clear();
  });
})();
