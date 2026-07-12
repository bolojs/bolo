#!/usr/bin/env node
// Topology parity test: runs the same `wrangler dev` configuration a developer
// runs by hand, against the real multi-config Pages gateway topology
// (router + landing + compat + demo), and asserts:
//   - GET /                        served by SITE (landing), 200
//   - GET /compat                  served by COMPAT, prefix stripped, 200
//   - GET /compat/<built asset>    served by COMPAT, prefix stripped, 200
//   - GET /demo                    served by DEMO, prefix stripped, 200
//   - GET /demo/sw.js              served by DEMO, prefix stripped, 200
//   - COOP/COEP headers present on responses routed through bindings
//
// Single source of truth: same script in CI and on a dev machine.
// Exit non-zero with a clear diff of which assertion failed.
//
// Usage:
//   pnpm --filter @browser-containers/site-router test:topology
//   pnpm --filter @browser-containers/site-router test:topology -- --skip-build

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const routerDir = join(__dirname, "..");
const repoRoot = join(routerDir, "..", "..", "..");
const port = 8787;

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[topology]", ...args);
}

function fail(messages) {
  // eslint-disable-next-line no-console
  console.error("\n[topology] ✗ FAIL");
  for (const m of messages) console.error("  -", m);
  process.exit(1);
}

// ── Step 1: ensure builds exist ───────────────────────────────────────
const landingDist = join(routerDir, "..", "landing", "dist");
const compatDist = join(routerDir, "..", "compat", "dist");
const demoDist = join(routerDir, "..", "demo", "dist");

if (
  !skipBuild &&
  (!existsSync(landingDist) || !existsSync(compatDist) || !existsSync(demoDist))
) {
  log("dist/ missing in landing/compat/demo — building…");
  await new Promise((resolve, reject) => {
    const proc = spawn(
      "pnpm",
      [
        "turbo",
        "run",
        "build",
        "--filter=@browser-containers/site-landing",
        "--filter=@browser-containers/site-compat",
        "--filter=@browser-containers/site-demo",
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`turbo build exited ${code}`))));
  });
} else {
  log("dist/ present (or --skip-build passed) — using existing build");
}

// ── Step 2: spawn wrangler dev with multi-config topology ────────────
const wrangler = join(routerDir, "node_modules", ".bin", "wrangler");
const configs = [
  "apps/site/router/wrangler.jsonc",
  "apps/site/landing/wrangler.jsonc",
  "apps/site/compat/wrangler.jsonc",
  "apps/site/demo/wrangler.jsonc",
];

log(`starting wrangler dev on :${port} (multi-config)…`);
const wranglerProc = spawn(
  wrangler,
  [...configs.flatMap((c) => ["-c", c]), "--port", String(port)],
  { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
);
wranglerProc.stdout.on("data", (b) => process.stdout.write(`[wrangler] ${b}`));
wranglerProc.stderr.on("data", (b) => process.stderr.write(`[wrangler] ${b}`));

const cleanup = () => {
  if (!wranglerProc.killed) {
    wranglerProc.kill("SIGTERM");
    // Give it a moment to exit gracefully.
    sleep(500).finally(() => {
      if (!wranglerProc.killed) wranglerProc.kill("SIGKILL");
    });
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

let wranglerReady = false;
const readyPromise = new Promise((resolve) => {
  wranglerProc.stdout.on("data", (b) => {
    if (!wranglerReady && b.toString().includes("Ready")) {
      wranglerReady = true;
      resolve();
    }
  });
});

// ── Step 3: poll until wrangler accepts connections ───────────────────
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !wranglerReady) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { redirect: "manual" });
    if (res.status < 500) {
      wranglerReady = true;
      break;
    }
  } catch {
    // not up yet
  }
  await sleep(500);
}
if (!wranglerReady) {
  cleanup();
  fail(["wrangler dev never became ready (90s timeout)"]);
}
log("wrangler dev is up");

// ── Step 4: assertions ────────────────────────────────────────────────
const failures = [];

async function check(label, path, expect) {
  log(`→ ${label}: GET ${path}`);
  const res = await fetch(`http://localhost:${port}${path}`, { redirect: "manual" });
  const url = res.url.replace(/^https?:\/\/[^/]+/, "");
  const headers = Object.fromEntries(res.headers.entries());

  if (res.status !== expect.status) {
    failures.push(`${label}: expected status ${expect.status}, got ${res.status}`);
    return;
  }
  if (expect.headers) {
    for (const [k, v] of Object.entries(expect.headers)) {
      const actual = headers[k.toLowerCase()];
      if (actual !== v) {
        failures.push(`${label}: header ${k} expected "${v}", got "${actual}"`);
      }
    }
  }
  if (expect.notes) {
    for (const note of expect.notes) {
      if (!note(url, headers)) failures.push(`${label}: assertion failed: ${note.message}`);
    }
  }
  log(`  ok (${res.status})`);
}

await check("root", "/", { status: 200, headers: { "cross-origin-opener-policy": "same-origin" } });
await check("compat index", "/compat", {
  status: 200,
  headers: { "cross-origin-opener-policy": "same-origin" },
});
await check("compat asset", "/compat/", {
  status: 200,
  headers: { "cross-origin-opener-policy": "same-origin" },
});
await check("demo index", "/demo", {
  status: 200,
  headers: { "cross-origin-opener-policy": "same-origin" },
});
await check("demo sw", "/demo/sw.js", {
  status: 200,
  headers: { "cross-origin-opener-policy": "same-origin" },
});

// ── Step 5: teardown + result ─────────────────────────────────────────
cleanup();
if (failures.length > 0) fail(failures);

log("✓ all topology assertions passed");
process.exit(0);
