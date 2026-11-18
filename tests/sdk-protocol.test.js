import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeBridge } from "../sdk/opencode-bridge.js";

function installFakeExtension(mode = "stream") {
  const requests = [];
  const messageListeners = [];
  const disconnectListeners = [];

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
      if (message.type === "hello") {
        queueMicrotask(() => emit({ type: "hello", protocolVersion: 1, extensionId: "test-extension" }));
        return;
      }

      if (message.type === "ping") {
        queueMicrotask(() => emit({ type: "pong" }));
        return;
      }

      if (message.type === "cancel") {
        queueMicrotask(() => emit({ type: "cancelled", requestId: message.requestId }));
        return;
      }

      if (message.type === "request") {
        requests.push(message);
        if (mode === "error") {
          queueMicrotask(() => emit({
            type: "error",
            requestId: message.requestId,
            error: {
              code: "UPSTREAM_HTTP_ERROR",
              message: "bad request",
              status: 400,
              body: "{\"error\":\"bad\"}"
            }
          }));
          return;
        }

        if (mode === "stream") {
          queueMicrotask(() => emit({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
          if (message.api === "anthropic.messages") {
            queueMicrotask(() => emit({
              type: "chunk",
              requestId: message.requestId,
              data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"he\"}}\n\n"
            }));
            queueMicrotask(() => emit({
              type: "chunk",
              requestId: message.requestId,
              data: "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"llo\"}}\n\n"
            }));
            queueMicrotask(() => emit({
              type: "chunk",
              requestId: message.requestId,
              data: "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
            }));
            queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
            return;
          }
          queueMicrotask(() => emit({
            type: "chunk",
            requestId: message.requestId,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"
          }));
          queueMicrotask(() => emit({
            type: "chunk",
            requestId: message.requestId,
            data: "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n"
          }));
          queueMicrotask(() => emit({ type: "chunk", requestId: message.requestId, data: "data: [DONE]\n\n" }));
          queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
          return;
        }

        const responseBody = message.api === "anthropic.messages"
          ? "{\"id\":\"msg_mock\",\"type\":\"message\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}],\"stop_reason\":\"end_turn\"}"
          : "{\"ok\":true}";
        queueMicrotask(() => emit({ type: "accepted", requestId: message.requestId, status: 200, headers: {} }));
        queueMicrotask(() => emit({
          type: "response",
          requestId: message.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBody
        }));
        queueMicrotask(() => emit({ type: "done", requestId: message.requestId }));
      }
    },
    disconnect() {
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

  return { requests };
}

test("streams parsed SSE events through the port", async () => {
  const fake = installFakeExtension("stream");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_test" });

  const stream = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk?.choices?.[0]?.delta?.content || "");
  }

  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(fake.requests[0].sessionId, "ses_test");
  assert.equal(fake.requests[0].api, "chat.completions");
  bridge.close();
});

test("returns a non-stream response with parsed JSON", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  const response = await conversation.chat.completions.create({
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: false
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.equal(fake.requests.length, 1);
  bridge.close();
});

test("forwards multimodal content arrays unchanged", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();
  const body = {
    model: "gpt-6-luna",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } }
      ]
    }],
    stream: false
  };

  await conversation.chat.completions.create(body);

  assert.deepEqual(fake.requests[0].body, body);
  bridge.close();
});

test("rejects with upstream error details", async () => {
  installFakeExtension("error");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  await assert.rejects(
    conversation.responses.create({ model: "gpt-6-luna", input: "hi", stream: false }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_HTTP_ERROR");
      assert.equal(error.status, 400);
      assert.equal(error.body, "{\"error\":\"bad\"}");
      return true;
    }
  );
  bridge.close();
});

test("streams Anthropic Messages events without a DONE sentinel", async () => {
  const fake = installFakeExtension("stream");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_anthropic" });

  const stream = await conversation.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    stream: true
  });

  const chunks = [];
  for await (const chunk of stream) {
    if (typeof chunk?.delta?.text === "string") chunks.push(chunk.delta.text);
  }

  assert.deepEqual(chunks, ["he", "llo"]);
  assert.equal(fake.requests[0].api, "anthropic.messages");
  assert.equal(fake.requests[0].sessionId, "ses_anthropic");
  bridge.close();
});

test("returns an Anthropic non-stream response", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  const response = await conversation.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    stream: false
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.type, "message");
  assert.equal(response.json.content[0].text, "hi");
  assert.equal(fake.requests[0].api, "anthropic.messages");
  bridge.close();
});

test("rejects Anthropic Messages upstream errors", async () => {
  installFakeExtension("error");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation();

  await assert.rejects(
    conversation.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
      stream: false
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_HTTP_ERROR");
      assert.equal(error.status, 400);
      assert.equal(error.body, "{\"error\":\"bad\"}");
      return true;
    }
  );
  bridge.close();
});

test("fetch adapter routes matching paths and ignores page auth", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_fetch" });
  const bridgeFetch = conversation.createFetch();

  const response = await bridgeFetch(
    "https://opencode.ai/inference/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { authorization: "page-key-must-be-ignored" },
      body: JSON.stringify({ model: "kimi-k3", messages: [], stream: false })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fake.requests[0].sessionId, "ses_fetch");
  bridge.close();
});

test("fetch adapter routes Anthropic Messages paths", async () => {
  const fake = installFakeExtension("response");
  const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
  const conversation = bridge.createConversation({ sessionId: "ses_anthropic_fetch" });
  const bridgeFetch = conversation.createFetch();

  const response = await bridgeFetch(
    "https://opencode.ai/inference/go/anthropic/v1/messages",
    {
      method: "POST",
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
        stream: false
      })
    }
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, "message");
  assert.equal(fake.requests[0].api, "anthropic.messages");
  assert.equal(fake.requests[0].sessionId, "ses_anthropic_fetch");
  bridge.close();
});

test("fetch adapter leaves a non-OpenCode /v1/messages request native", async () => {
  const originalFetch = globalThis.fetch;
  let nativeCalled = false;
  globalThis.fetch = async () => {
    nativeCalled = true;
    return new Response("native", { status: 200 });
  };

  try {
    const fake = installFakeExtension("response");
    const bridge = new OpenCodeBridge({ extensionId: "test-extension" });
    const conversation = bridge.createConversation();
    const bridgeFetch = conversation.createFetch();

    const response = await bridgeFetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "x", max_tokens: 1, messages: [] })
      }
    );

    assert.equal(nativeCalled, true);
    assert.equal(await response.text(), "native");
    assert.equal(fake.requests.length, 0);
    bridge.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
