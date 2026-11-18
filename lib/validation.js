// Shared, dependency-free validation helpers.
// This module is imported by the MV3 service worker and by Node tests.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const API_TYPES = new Set(["chat.completions", "responses", "anthropic.messages", "models.list"]);

export const MIB = 1024 * 1024;
export const MIN_MAX_BODY_BYTES = 1 * MIB;
export const MAX_MAX_BODY_BYTES = 32 * MIB;
export const DEFAULT_MAX_BODY_BYTES = 32 * MIB;

const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade"
]);

export function normalizeOrigin(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "Origin must be a string." };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Origin is empty." };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http and https origins are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Origins must not contain credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Origins must not contain a query or hash." };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, error: "Origins must not contain a path." };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Plain HTTP is only allowed for localhost." };
  }
  if (!url.hostname) {
    return { ok: false, error: "Origin is missing a host." };
  }

  return { ok: true, origin: url.origin };
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== "string" || !origin || origin === "null") {
    return false;
  }
  if (!Array.isArray(allowedOrigins)) {
    return false;
  }
  return allowedOrigins.some((allowed) => typeof allowed === "string" && allowed === origin);
}

export function parseBaseUrl(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "Base URL must be a string." };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: "Base URL is empty." };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid base URL." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "Custom base URLs must use HTTPS." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Base URLs must not contain credentials." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Base URLs must not contain a query or hash." };
  }
  if (isForbiddenCustomHost(url.hostname)) {
    return { ok: false, error: "Custom base URLs may not point at localhost or a private address." };
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: `${url.origin}${path}` };
}

export function isForbiddenCustomHost(hostname) {
  if (typeof hostname !== "string" || !hostname) {
    return true;
  }

  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  while (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  if (!host) return true;
  // IPv6 zone identifiers (e.g. fe80::1%25eth0) are local-only.
  if (host.includes("%")) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;
  if (host.includes(":")) return isForbiddenIpv6(host);
  if (isIpv4Literal(host)) return isForbiddenIpv4(host);
  return false;
}

function isIpv4Literal(host) {
  const parts = host.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isForbiddenIpv4(host) {
  const [a, b, c] = host.split(".").map(Number);

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;

  return false;
}

function parseIpv6(host) {
  let text = host;

  // Support dotted IPv4 tails even though WHATWG URL normally canonicalizes
  // them into two hex groups first.
  if (text.includes(".")) {
    const separator = text.lastIndexOf(":");
    if (separator === -1) return null;
    const tail = text.slice(separator + 1);
    if (!isIpv4Literal(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, separator + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;

  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;

  const values = groups.map((group) => (
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN
  ));
  return values.some(Number.isNaN) ? null : values;
}

function isForbiddenIpv6(host) {
  const groups = parseIpv6(host);
  if (!groups) return true;

  // Unspecified and loopback.
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;

  const first = groups[0];

  // Link-local fe80::/10, deprecated site-local fec0::/10, unique-local
  // fc00::/7, multicast ff00::/8, and documentation 2001:db8::/32.
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && groups[1] === 0x0db8) return true;

  const embedded = (high, low) => (
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  );

  // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    if ((groups[5] === 0xffff || groups[5] === 0)
      && isForbiddenIpv4(embedded(groups[6], groups[7]))) {
      return true;
    }
  }

  // NAT64 well-known prefix 64:ff9b::/96.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b
    && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0
    && isForbiddenIpv4(embedded(groups[6], groups[7]))) {
    return true;
  }

  // 6to4 2002::/16 embeds an IPv4 address in the next two groups.
  if (groups[0] === 0x2002 && isForbiddenIpv4(embedded(groups[1], groups[2]))) {
    return true;
  }

  return false;
}

export function providerBaseUrl(provider, customBaseUrl) {
  if (provider === "console") {
    return "https://opencode.ai/inference";
  }
  if (provider === "go") {
    return "https://opencode.ai/inference/go";
  }
  if (provider === "custom") {
    const parsed = parseBaseUrl(customBaseUrl);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.baseUrl;
  }
  throw new Error("Unknown provider.");
}

export function buildEndpoints(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    base,
    chat: `${base}/openai/v1/chat/completions`,
    responses: `${base}/openai/v1/responses`,
    messages: `${base}/anthropic/v1/messages`,
    models: `${base}/v1/models`
  };
}

export function endpointFor(api, endpoints) {
  if (api === "chat.completions") return endpoints.chat;
  if (api === "responses") return endpoints.responses;
  if (api === "anthropic.messages") return endpoints.messages;
  if (api === "models.list") return endpoints.models;
  throw new Error("Unsupported API.");
}

export function byteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text).byteLength;
}

export function parseMaxBodyMiB(value) {
  const mib = Number(value);
  const minMib = MIN_MAX_BODY_BYTES / MIB;
  const maxMib = MAX_MAX_BODY_BYTES / MIB;
  if (!Number.isInteger(mib) || mib < minMib || mib > maxMib) {
    return {
      ok: false,
      error: `Request body limit must be an integer between ${minMib} and ${maxMib} MiB.`
    };
  }
  return { ok: true, bytes: mib * MIB };
}

export function validateRequestBody(api, body) {
  if (!API_TYPES.has(api)) {
    return { ok: false, error: "Unsupported API type." };
  }

  if (api === "models.list") {
    if (body !== undefined && body !== null) {
      return { ok: false, error: "models.list does not accept a request body." };
    }
    return { ok: true };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  if (typeof body.model !== "string" || body.model.length < 1 || body.model.length > 200) {
    return { ok: false, error: "body.model must be a non-empty string of at most 200 characters." };
  }
  if ("stream" in body && typeof body.stream !== "boolean") {
    return { ok: false, error: "body.stream must be a boolean." };
  }
  if (api === "chat.completions" && body.messages !== undefined && !Array.isArray(body.messages)) {
    return { ok: false, error: "body.messages must be an array." };
  }
  if (api === "responses" && body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) {
    return { ok: false, error: "body.input must be a string or an array." };
  }
  if (api === "anthropic.messages") {
    if (!Array.isArray(body.messages)) {
      return { ok: false, error: "body.messages must be an array." };
    }
    if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
      return { ok: false, error: "body.max_tokens must be a positive integer." };
    }
    if (body.system !== undefined) {
      const validSystem = typeof body.system === "string"
        || (Array.isArray(body.system) && body.system.every((block) => (
          block && typeof block === "object" && !Array.isArray(block)
        )));
      if (!validSystem) {
        return { ok: false, error: "body.system must be a string or an array of content blocks." };
      }
    }
    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      return { ok: false, error: "body.tools must be an array." };
    }
  }

  return { ok: true };
}

export function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

export function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function truncateText(text, maxBytes = 65536) {
  if (typeof text !== "string") {
    return "";
  }
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text).slice(0, maxBytes);
  return decoder.decode(bytes);
}

export function sanitizeResponseHeaders(headers) {
  const out = {};
  if (!headers) {
    return out;
  }

  const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    const lower = String(key).toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    if (lower.startsWith("access-control-")) {
      continue;
    }
    if (lower.startsWith("proxy-")) {
      continue;
    }
    out[lower] = String(value);
  }
  return out;
}
