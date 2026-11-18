import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEndpoints,
  byteLength,
  DEFAULT_MAX_BODY_BYTES,
  endpointFor,
  isForbiddenCustomHost,
  isOriginAllowed,
  isValidRequestId,
  isValidSessionId,
  MAX_MAX_BODY_BYTES,
  MIB,
  MIN_MAX_BODY_BYTES,
  normalizeOrigin,
  parseBaseUrl,
  parseMaxBodyMiB,
  providerBaseUrl,
  sanitizeResponseHeaders,
  truncateText,
  validateRequestBody
} from "../lib/validation.js";

test("normalizes a bare HTTPS origin", () => {
  assert.deepEqual(normalizeOrigin("https://example.com"), {
    ok: true,
    origin: "https://example.com"
  });
});

test("normalizes a localhost HTTP origin with a port", () => {
  assert.deepEqual(normalizeOrigin("http://localhost:8000"), {
    ok: true,
    origin: "http://localhost:8000"
  });
});

test("rejects plain HTTP for a non-loopback host", () => {
  assert.equal(normalizeOrigin("http://example.com").ok, false);
});

test("rejects origins with a path", () => {
  assert.equal(normalizeOrigin("https://example.com/app").ok, false);
});

test("rejects credentials and query strings", () => {
  assert.equal(normalizeOrigin("https://user:pass@example.com").ok, false);
  assert.equal(normalizeOrigin("https://example.com?x=1").ok, false);
});

test("rejects non-http schemes", () => {
  assert.equal(normalizeOrigin("file:///tmp/page.html").ok, false);
});

test("matches origins exactly, not by prefix", () => {
  const allowed = ["https://example.com"];
  assert.equal(isOriginAllowed("https://example.com", allowed), true);
  assert.equal(isOriginAllowed("https://example.com.evil", allowed), false);
  assert.equal(isOriginAllowed("https://example.com:8443", allowed), false);
  assert.equal(isOriginAllowed("null", allowed), false);
});

test("parses a base URL and strips a trailing slash", () => {
  assert.deepEqual(parseBaseUrl("https://example.com/inference/"), {
    ok: true,
    baseUrl: "https://example.com/inference"
  });
});

test("rejects HTTP, localhost, and private custom base URLs", () => {
  assert.equal(parseBaseUrl("http://example.com").ok, false);
  assert.equal(parseBaseUrl("https://localhost").ok, false);
  assert.equal(parseBaseUrl("https://127.0.0.1").ok, false);
  assert.equal(parseBaseUrl("https://192.168.1.10").ok, false);
});

test("detects private address literals", () => {
  assert.equal(isForbiddenCustomHost("127.0.0.1"), true);
  assert.equal(isForbiddenCustomHost("10.0.0.1"), true);
  assert.equal(isForbiddenCustomHost("172.16.0.1"), true);
  assert.equal(isForbiddenCustomHost("192.168.1.1"), true);
  assert.equal(isForbiddenCustomHost("169.254.169.254"), true);
  assert.equal(isForbiddenCustomHost("0.1.2.3"), true);
  assert.equal(isForbiddenCustomHost("192.0.2.1"), true);
  assert.equal(isForbiddenCustomHost("198.18.0.1"), true);
  assert.equal(isForbiddenCustomHost("198.51.100.1"), true);
  assert.equal(isForbiddenCustomHost("203.0.113.1"), true);
  assert.equal(isForbiddenCustomHost("224.0.0.1"), true);
  assert.equal(isForbiddenCustomHost("255.255.255.255"), true);
  assert.equal(isForbiddenCustomHost("123.example.com"), false);
  assert.equal(isForbiddenCustomHost("8.8.8.8"), false);
});

test("detects private and reserved IPv6 custom hosts", () => {
  for (const host of [
    "[::]",
    "[::1]",
    "[::0:1]",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:10.0.0.1]",
    "[::ffff:192.168.1.1]",
    "[fe80::1]",
    "[fec0::1]",
    "[fc00::1]",
    "[fd12:3456:789a::1]",
    "[2001:db8::1]",
    "[64:ff9b::127.0.0.1]",
    "[2002:7f00:1::]",
    "localhost.",
    "metadata.google.internal."
  ]) {
    assert.equal(isForbiddenCustomHost(host), true, host);
  }

  assert.equal(isForbiddenCustomHost("[::ffff:8.8.8.8]"), false);
  assert.equal(isForbiddenCustomHost("[2606:4700:4700::1111]"), false);
  assert.equal(isForbiddenCustomHost("[2001:4860:4860::8888]"), false);
});

test("rejects private IPv6 and reserved IPv4 custom base URLs", () => {
  for (const host of [
    "[::1]",
    "[::]",
    "[::ffff:127.0.0.1]",
    "[fe80::1]",
    "[fc00::1]",
    "[2001:db8::1]",
    "[64:ff9b::127.0.0.1]",
    "0.1.2.3",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "240.0.0.1",
    "localhost."
  ]) {
    assert.equal(parseBaseUrl(`https://${host}/`).ok, false, host);
  }

  assert.deepEqual(parseBaseUrl("https://[2606:4700:4700::1111]/"), {
    ok: true,
    baseUrl: "https://[2606:4700:4700::1111]"
  });
});

test("builds provider base URLs", () => {
  assert.equal(providerBaseUrl("console", ""), "https://opencode.ai/inference");
  assert.equal(providerBaseUrl("go", ""), "https://opencode.ai/inference/go");
});

test("builds endpoint paths", () => {
  const endpoints = buildEndpoints("https://opencode.ai/inference/go/");
  assert.deepEqual(endpoints, {
    base: "https://opencode.ai/inference/go",
    chat: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    responses: "https://opencode.ai/inference/go/openai/v1/responses",
    messages: "https://opencode.ai/inference/go/anthropic/v1/messages",
    models: "https://opencode.ai/inference/go/v1/models"
  });
  assert.equal(endpointFor("anthropic.messages", endpoints), "https://opencode.ai/inference/go/anthropic/v1/messages");
});

test("accepts a valid chat request body", () => {
  assert.equal(validateRequestBody("chat.completions", {
    model: "kimi-k3",
    messages: [{ role: "user", content: "hi" }],
    stream: true
  }).ok, true);
});

test("accepts a valid responses request body", () => {
  assert.equal(validateRequestBody("responses", {
    model: "gpt-6-luna",
    input: "hi",
    stream: false
  }).ok, true);
});

test("accepts valid anthropic messages bodies", () => {
  assert.equal(validateRequestBody("anthropic.messages", {
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }]
  }).ok, true);
  assert.equal(validateRequestBody("anthropic.messages", {
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    system: "you are helpful",
    tools: [],
    stream: true
  }).ok, true);
  assert.equal(validateRequestBody("anthropic.messages", {
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    system: [{ type: "text", text: "you are helpful" }]
  }).ok, true);
});

test("rejects invalid anthropic messages bodies", () => {
  const base = {
    model: "claude-haiku-5-5",
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }]
  };

  for (const maxTokens of [undefined, 0, -1, 4096.5, "4096"]) {
    assert.equal(validateRequestBody("anthropic.messages", {
      ...base,
      max_tokens: maxTokens
    }).ok, false, String(maxTokens));
  }
  assert.equal(validateRequestBody("anthropic.messages", {
    model: "claude-haiku-5-5",
    max_tokens: 128
  }).ok, false);
  assert.equal(validateRequestBody("anthropic.messages", {
    ...base,
    messages: "not an array"
  }).ok, false);
  assert.equal(validateRequestBody("anthropic.messages", {
    ...base,
    system: 123
  }).ok, false);
  assert.equal(validateRequestBody("anthropic.messages", {
    ...base,
    system: ["not a block"]
  }).ok, false);
  assert.equal(validateRequestBody("anthropic.messages", {
    ...base,
    tools: {}
  }).ok, false);
});

test("rejects missing models and non-boolean stream", () => {
  assert.equal(validateRequestBody("chat.completions", {
    messages: []
  }).ok, false);
  assert.equal(validateRequestBody("chat.completions", {
    model: "kimi-k3",
    stream: "yes"
  }).ok, false);
});

test("parses request body limits in MiB", () => {
  assert.deepEqual(parseMaxBodyMiB("1"), { ok: true, bytes: MIN_MAX_BODY_BYTES });
  assert.deepEqual(parseMaxBodyMiB("32"), { ok: true, bytes: MAX_MAX_BODY_BYTES });
  assert.equal(DEFAULT_MAX_BODY_BYTES, MAX_MAX_BODY_BYTES);
  assert.equal(MAX_MAX_BODY_BYTES / MIB, 32);

  for (const value of ["0", "33", "1.5", "abc", "", null, undefined, "NaN"]) {
    assert.equal(parseMaxBodyMiB(value).ok, false, String(value));
  }
});

test("passes multimodal content parts through unchanged", () => {
  const chatBody = {
    model: "gpt-6-luna",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } }
      ]
    }]
  };
  const chatSnapshot = structuredClone(chatBody);
  assert.equal(validateRequestBody("chat.completions", chatBody).ok, true);
  assert.deepEqual(chatBody, chatSnapshot);

  const anthropicBody = {
    model: "claude-haiku-5-5",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "Describe this." }
      ]
    }]
  };
  const anthropicSnapshot = structuredClone(anthropicBody);
  assert.equal(validateRequestBody("anthropic.messages", anthropicBody).ok, true);
  assert.deepEqual(anthropicBody, anthropicSnapshot);

  const responsesBody = {
    model: "gpt-6-luna",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Describe this." },
        { type: "input_image", image_url: "https://example.com/cat.png" }
      ]
    }]
  };
  const responsesSnapshot = structuredClone(responsesBody);
  assert.equal(validateRequestBody("responses", responsesBody).ok, true);
  assert.deepEqual(responsesBody, responsesSnapshot);
});

test("rejects a body for models.list", () => {
  assert.equal(validateRequestBody("models.list", {}).ok, false);
  assert.equal(validateRequestBody("models.list", null).ok, true);
});

test("validates request and session IDs", () => {
  assert.equal(isValidRequestId("req_abc-123"), true);
  assert.equal(isValidRequestId("bad id"), false);
  assert.equal(isValidSessionId("ses_abc-123"), true);
  assert.equal(isValidSessionId(""), false);
});

test("measures UTF-8 bytes", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("你"), 3);
});

test("truncates text by bytes", () => {
  const value = "a".repeat(100);
  assert.equal(truncateText(value, 10).length, 10);
});

test("drops hop-by-hop and sensitive response headers", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": "10",
    "set-cookie": "a=b",
    "x-request-id": "abc",
    "access-control-allow-origin": "*"
  });
  const result = sanitizeResponseHeaders(headers);

  assert.equal(result["content-type"], "application/json");
  assert.equal(result["x-request-id"], "abc");
  assert.equal("content-encoding" in result, false);
  assert.equal("content-length" in result, false);
  assert.equal("set-cookie" in result, false);
  assert.equal("access-control-allow-origin" in result, false);
});
