import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeBridge } from "../sdk/opencode-bridge.js";

const PAGE_ORIGIN = "https://demo.test";
const MARKER = "__opencodeBridge";

function installSilentDirect({ answerHello = false } = {}) {
  const requests = [];
  const messageListeners = [];
  const disconnectListeners = [];
  const state = { disconnectCalls: 0 };

  const port = {
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      if (!answerHello) return;

      if (message.type === "hello") {
        queueMicrotask(() => emit({ type: "hello", protocolVersion: 1, extensionId: "test-extension" }));
        return;
      }
      if (message.type === "ping") {
        queueMicrotask(() => emit({ type: "pong" }));
        return;
      }
      if (message.type === "request") {
        requests.push(message);
        queueMicrotask(() => emit({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
        if (message.body && message.body.stream === true) {
          queueMicrotask(() => emit({
            type: "chunk",
            requestId: message.requestId,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"
          }));
          queueMicrotask(() => emit({ type: "chunk", requestId: message.requestId, data: "data: [DONE]\n\n" }));
        } else {
          queueMicrotask(() => emit({
            type: "response",
            requestId: message.requestId,
            status: 200,
            headers: { "content-type": "application/json" },
            body: "{\"ok\":true}"
          }));
        }
        queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
      }
    },
    disconnect() {
      state.disconnectCalls += 1;
      for (const listener of disconnectListeners) listener();
    }
  };

  function emit(message) {
    for (const listener of messageListeners) listener(message);
  }

  globalThis.chrome = {
    runtime: {
      connect() {
        return port;
      }
    }
  };

  return { requests, state, port };
}

/**
 * A fake page window that also plays the content script and service worker.
 * postMessage enqueues the message as a microtask and, when the relay is
 * enabled, dispatches the corresponding reply back to the page listeners.
 */
function installFakeRelay({ answerProbe = true, ackOrigin = PAGE_ORIGIN } = {}) {
  const listeners = new Set();
  const envelopes = [];

  const win = {
    postMessage(data, targetOrigin) {
      envelopes.push({ data, targetOrigin });
      queueMicrotask(() => {
        if (!data || data[MARKER] !== 1) return;

        if (data.kind === "probe") {
          if (!answerProbe) return;
          dispatch({
            source: win,
            origin: ackOrigin,
            data: { [MARKER]: 1, source: "relay", kind: "probe-ack", nonce: data.nonce }
          });
          return;
        }

        if (data.kind === "open") {
          dispatch({
            source: win,
            origin: PAGE_ORIGIN,
            data: {
              [MARKER]: 1,
              source: "relay",
              kind: "msg",
              portId: data.portId,
              seq: 1,
              payload: { type: "hello", protocolVersion: 1, extensionId: "test-extension" }
            }
          });
          return;
        }

        if (data.kind === "msg") {
          const message = data.payload;
          const reply = (payload) => dispatch({
            source: win,
            origin: PAGE_ORIGIN,
            data: { [MARKER]: 1, source: "relay", kind: "msg", portId: data.portId, seq: 2, payload }
          });

          if (!message || message.type === "ping") {
            queueMicrotask(() => reply({ type: "pong" }));
            return;
          }
          if (message.type === "request") {
            queueMicrotask(() => reply({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
            if (message.body && message.body.stream === true) {
              queueMicrotask(() => reply({
                type: "chunk",
                requestId: message.requestId,
                data: "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"
              }));
              queueMicrotask(() => reply({
                type: "chunk",
                requestId: message.requestId,
                data: "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n"
              }));
              queueMicrotask(() => reply({ type: "chunk", requestId: message.requestId, data: "data: [DONE]\n\n" }));
            } else {
              queueMicrotask(() => reply({
                type: "response",
                requestId: message.requestId,
                status: 200,
                headers: { "content-type": "application/json" },
                body: "{\"ok\":true}"
              }));
            }
            queueMicrotask(() => reply({ type: "done", requestId: message.requestId }));
            return;
          }
          if (message.type === "cancel") {
            queueMicrotask(() => reply({ type: "cancelled", requestId: message.requestId }));
          }
        }

        // "close" needs no reply.
      });
    },
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    }
  };

  function dispatch(event) {
    for (const listener of [...listeners]) listener(event);
  }

  globalThis.window = win;
  globalThis.location = { origin: PAGE_ORIGIN };

  return { win, envelopes, listenerCount: () => listeners.size };
}

function withGlobals(run) {
  const saved = {
    chrome: globalThis.chrome,
    browser: globalThis.browser,
    window: globalThis.window,
    location: globalThis.location
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      restore("chrome", saved.chrome);
      restore("browser", saved.browser);
      restore("window", saved.window);
      restore("location", saved.location);
    });
}

function restore(key, value) {
  if (value === undefined) {
    delete globalThis[key];
  } else {
    globalThis[key] = value;
  }
}

function streamChunks(stream) {
  return (async () => {
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk?.choices?.[0]?.delta?.content || "");
    }
    return chunks;
  })();
}

test("uses browser.runtime when chrome.runtime is absent", () => withGlobals(async () => {
  const fake = installSilentDirect({ answerHello: true });
  delete globalThis.chrome;
  globalThis.browser = { runtime: { connect: () => fake.port } };

  const bridge = new OpenCodeBridge({ extensionId: "test-extension", transport: "direct" });
  const conversation = bridge.createConversation();
  const response = await conversation.chat.completions.create({ model: "m", messages: [], stream: false });

  assert.equal(response.status, 200);
  assert.equal(bridge.transport, "direct");
  bridge.close();
}));

test("auto transport falls back to the content-script relay", () => withGlobals(async () => {
  const direct = installSilentDirect({ answerHello: false });
  const relay = installFakeRelay();

  const bridge = new OpenCodeBridge({
    extensionId: "test-extension",
    directProbeTimeoutMs: 60,
    relayProbeTimeoutMs: 200
  });
  const conversation = bridge.createConversation({ sessionId: "ses_relay" });

  const stream = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });
  const chunks = await streamChunks(stream);

  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(bridge.transport, "relay");
  assert.ok(direct.state.disconnectCalls >= 1, "the failed direct probe must be disconnected");

  const open = relay.envelopes.find((entry) => entry.data.kind === "open");
  assert.equal(open.data[MARKER], 1);
  assert.equal(open.data.source, "page");
  assert.match(open.data.portId, /^prt_/);
  assert.equal(open.data.payload.type, "hello");
  assert.equal(open.targetOrigin, PAGE_ORIGIN);
  assert.ok(
    relay.envelopes.every((entry) => entry.data.source === "page"),
    "every outgoing envelope must be tagged as page-originated"
  );

  const messages = relay.envelopes.filter((entry) => entry.data.kind === "msg");
  assert.ok(messages.some((entry) => entry.data.payload.type === "request"));
  const seqs = messages.map((entry) => entry.data.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], "envelope seq must be monotonic");
  }

  bridge.close();
  assert.equal(relay.listenerCount(), 0, "relay listener must be removed on close");
}));

test("forced relay transport works without any runtime", () => withGlobals(async () => {
  delete globalThis.chrome;
  delete globalThis.browser;
  installFakeRelay();

  const bridge = new OpenCodeBridge({
    extensionId: "test-extension",
    transport: "relay",
    relayProbeTimeoutMs: 200
  });
  const conversation = bridge.createConversation();
  const response = await conversation.responses.create({ model: "m", input: "hi", stream: false });

  assert.equal(response.status, 200);
  assert.equal(bridge.transport, "relay");
  bridge.close();
}));

test("missing content script reports CONTENT_SCRIPT_MISSING with a hint", () => withGlobals(async () => {
  installFakeRelay({ answerProbe: false });
  delete globalThis.chrome;
  delete globalThis.browser;

  const bridge = new OpenCodeBridge({
    extensionId: "test-extension",
    transport: "relay",
    relayProbeTimeoutMs: 60
  });
  const conversation = bridge.createConversation();

  await assert.rejects(
    conversation.chat.completions.create({ model: "m", messages: [], stream: false }),
    (error) => {
      assert.equal(error.code, "CONTENT_SCRIPT_MISSING");
      assert.match(error.hint, /Website Access/);
      return true;
    }
  );
}));

test("probe replies from a foreign origin are ignored", () => withGlobals(async () => {
  installFakeRelay({ answerProbe: true, ackOrigin: "https://evil.test" });
  delete globalThis.chrome;
  delete globalThis.browser;

  const bridge = new OpenCodeBridge({
    extensionId: "test-extension",
    transport: "relay",
    relayProbeTimeoutMs: 60
  });

  await assert.rejects(
    bridge.createConversation().chat.completions.create({ model: "m", messages: [], stream: false }),
    (error) => error.code === "CONTENT_SCRIPT_MISSING"
  );
}));

test("forced direct transport without a runtime reports NO_CHROME_RUNTIME", () => withGlobals(async () => {
  delete globalThis.chrome;
  delete globalThis.browser;

  const bridge = new OpenCodeBridge({ extensionId: "test-extension", transport: "direct" });

  await assert.rejects(
    bridge.createConversation().chat.completions.create({ model: "m", messages: [], stream: false }),
    (error) => error.code === "NO_CHROME_RUNTIME"
  );
}));

test("rejects an unknown transport option", () => {
  assert.throws(
    () => new OpenCodeBridge({ extensionId: "test-extension", transport: "carrier-pigeon" }),
    (error) => error.code === "BAD_TRANSPORT"
  );
});
