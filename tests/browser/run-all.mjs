// Launch a real Chromium with the unpacked extension and run the browser tests.
//
//   CHROME_BIN=/usr/lib/chromium/chromium node tests/browser/run-all.mjs
//   CHROME_BIN=/usr/bin/google-chrome node tests/browser/run-all.mjs --first-byte
//   CHROME_BIN=... node tests/browser/run-all.mjs --long
//
// The browser tests use a temporary profile under /tmp and are removed on exit.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const chrome = process.env.CHROME_BIN || "/usr/lib/chromium/chromium";
const port = Number(process.env.CDP_PORT || 9490);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-browser-"));
const extraArgs = process.argv.slice(2);

const browser = spawn(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=" + profile,
  "--remote-debugging-port=" + String(port),
  "--disable-extensions-except=" + root,
  "--load-extension=" + root,
  "about:blank"
], {
  stdio: ["ignore", "inherit", "inherit"]
});

let browserExited = false;
browser.on("exit", () => {
  browserExited = true;
});

try {
  await waitForExtension();
  let exitCode = 0;
  exitCode = await runTest("protocol-test.mjs", extraArgs);
  if (exitCode === 0) {
    exitCode = await runTest("failure-test.mjs", []);
  } else {
    console.error("Skipping failure and relay tests because protocol tests failed.");
  }
  if (exitCode === 0) {
    exitCode = await runTest("relay-test.mjs", []);
  }
  process.exitCode = exitCode;
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  try {
    browser.kill("SIGTERM");
  } catch {
    // Ignore.
  }
  await sleep(500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Ignore.
  }
}

async function waitForExtension() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (browserExited) {
      throw new Error("Chromium exited before the extension loaded.");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (targets.some((target) => target.type === "service_worker" && target.url.includes("/background/service-worker.js"))) {
          return;
        }
      }
    } catch {
      // Browser is still starting.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the extension service worker.");
}

function runTest(file, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "tests/browser", file), String(port), ...args], {
      stdio: "inherit"
    });
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
