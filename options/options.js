import {
  isForbiddenCustomHost,
  normalizeOrigin,
  parseBaseUrl,
  providerBaseUrl
} from "../lib/validation.js";

const $ = (id) => document.getElementById(id);

let current = {};

document.addEventListener("DOMContentLoaded", () => {
  void init();
});

async function init() {
  current = await chrome.storage.local.get(null);

  $("provider").value = current.provider || "console";
  $("customBaseUrl").value = current.customBaseUrl || "";
  $("clientUserAgent").value = current.clientUserAgent || "opencode-bridge/0.1.0";
  $("allowedOrigins").value = Array.isArray(current.allowedOrigins)
    ? current.allowedOrigins.join("\n")
    : "";
  $("extensionId").textContent = chrome.runtime.id;
  $("apiKey").value = "";
  updateKeyPlaceholder();
  showTransportInfo();

  $("provider").addEventListener("change", updateCustomRow);
  $("showKey").addEventListener("change", () => {
    $("apiKey").type = $("showKey").checked ? "text" : "password";
  });
  $("clearKey").addEventListener("click", clearKey);
  $("copyExtensionId").addEventListener("click", copyExtensionId);
  $("save").addEventListener("click", () => {
    void save();
  });

  updateCustomRow();
}

function updateCustomRow() {
  const custom = $("provider").value === "custom";
  $("customRow").hidden = !custom;
  $("customBaseUrl").required = custom;
}

function showTransportInfo() {
  const ua = navigator.userAgent || "";
  const isSafari = /Safari\//.test(ua)
    && !/(Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS)\//.test(ua);

  $("transportStatus").textContent = isSafari
    ? "Safari detected. Web pages use the content-script relay; direct page connections are currently unreliable in Safari."
    : "Direct page connections are available. The content-script relay is used automatically when a direct connection cannot complete.";

  $("safariNote").hidden = !isSafari;
}

function updateKeyPlaceholder() {
  $("apiKey").placeholder = current.apiKey ? "•••••••• (saved)" : "oc_sk_...";
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message || "";
  status.classList.toggle("error", Boolean(isError));
  status.classList.toggle("ok", Boolean(message) && !isError);
}

async function clearKey() {
  await chrome.storage.local.remove("apiKey");
  current = await chrome.storage.local.get(null);
  $("apiKey").value = "";
  updateKeyPlaceholder();
  setStatus("Saved API key cleared.");
}

async function copyExtensionId() {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    setStatus("Extension ID copied.");
  } catch {
    setStatus("Could not copy. Select the ID manually.", true);
  }
}

async function save() {
  setStatus("");

  const provider = $("provider").value;
  const customBaseUrl = $("customBaseUrl").value.trim();

  let resolvedBaseUrl;
  try {
    resolvedBaseUrl = providerBaseUrl(provider, customBaseUrl);
  } catch (error) {
    setStatus(error?.message || "Invalid provider configuration.", true);
    return;
  }

  // Ask for the optional host permission while the click gesture is still
  // active. Do this before any other await.
  if (provider === "custom") {
    const parsed = parseBaseUrl(customBaseUrl);
    if (!parsed.ok) {
      setStatus(parsed.error, true);
      return;
    }
    const host = new URL(parsed.baseUrl).hostname;
    if (isForbiddenCustomHost(host)) {
      setStatus("Custom base URLs may not point at localhost or a private address.", true);
      return;
    }

    const customOrigin = new URL(parsed.baseUrl).origin;
    if (customOrigin !== "https://opencode.ai") {
      const originPattern = `${customOrigin}/*`;
      try {
        const granted = await chrome.permissions.request({ origins: [originPattern] });
        if (!granted) {
          setStatus("Host permission for the custom base URL was not granted.", true);
          return;
        }
      } catch (error) {
        setStatus(error?.message || "Could not request host permission.", true);
        return;
      }
    }
  }

  const originLines = $("allowedOrigins").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const allowedOrigins = [];
  for (const line of originLines) {
    const parsed = normalizeOrigin(line);
    if (!parsed.ok) {
      setStatus(`${line}: ${parsed.error}`, true);
      return;
    }
    if (!allowedOrigins.includes(parsed.origin)) {
      allowedOrigins.push(parsed.origin);
    }
  }

  const userAgent = $("clientUserAgent").value.trim();
  if (/[\r\n]/.test(userAgent) || userAgent.length > 256) {
    setStatus("User-Agent must be a single line of at most 256 characters.", true);
    return;
  }

  const newKey = $("apiKey").value.trim();
  if (newKey && (/[\r\n]/.test(newKey) || newKey.length > 512)) {
    setStatus("API key must be a single line of at most 512 characters.", true);
    return;
  }

  const update = {
    provider,
    customBaseUrl: provider === "custom" ? resolvedBaseUrl : "",
    allowedOrigins,
    clientUserAgent: userAgent
  };
  if (newKey) {
    update.apiKey = newKey;
  }

  try {
    await chrome.storage.local.set(update);
  } catch (error) {
    setStatus(error?.message || "Could not save settings.", true);
    return;
  }

  // Release the old optional host permission when leaving a custom provider or
  // changing the custom host.
  if (current.provider === "custom" && current.customBaseUrl) {
    const old = parseBaseUrl(current.customBaseUrl);
    const newOrigin = provider === "custom" ? new URL(resolvedBaseUrl).origin : null;
    if (old.ok) {
      const oldOrigin = new URL(old.baseUrl).origin;
      if (oldOrigin !== "https://opencode.ai" && oldOrigin !== newOrigin) {
        try {
          await chrome.permissions.remove({ origins: [`${oldOrigin}/*`] });
        } catch {
          // Best effort only.
        }
      }
    }
  }

  current = await chrome.storage.local.get(null);
  $("apiKey").value = "";
  updateKeyPlaceholder();
  updateCustomRow();
  setStatus("Settings saved.");
}
