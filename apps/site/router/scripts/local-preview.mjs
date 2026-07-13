#!/usr/bin/env node
// Local-only static preview of the stitched site topology (router + landing +
// compat + demo + docs), mirroring functions/_middleware.ts's prefix routing.
//
// Not used in CI/build — wrangler's multi-config Pages-to-Pages service
// binding dev doesn't work locally (see test-topology.mjs), so this serves
// the four built dist/ dirs directly over plain HTTP for manual QA.
//
// Usage: node scripts/local-preview.mjs [port]

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const routerDir = join(__dirname, "..");
const port = Number(process.argv[2]) || 8787;

const MOUNTS = [
  { prefix: "/compat", dir: join(routerDir, "..", "compat", "dist") },
  { prefix: "/demo", dir: join(routerDir, "..", "demo", "dist") },
  { prefix: "/docs", dir: join(routerDir, "..", "docs", "dist") },
];
const rootDir = join(routerDir, "..", "landing", "dist");

// Each app's dist/_headers pins its own COOP/COEP policy (e.g. demo needs
// `credentialless` for its cross-origin npm-registry fetches, while the
// others use `require-corp`) — read it per-mount instead of forcing one
// policy on every route, or the demo runtime silently hangs at "booting".
function readCoepHeaders(dir) {
  const headersPath = join(dir, "_headers");
  const defaults = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (!existsSync(headersPath)) return defaults;
  const text = readFileSync(headersPath, "utf8");
  const found = { ...defaults };
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(Cross-Origin-Opener-Policy|Cross-Origin-Embedder-Policy):\s*(\S+)/);
    if (match) found[match[1]] = match[2];
  }
  return found;
}

const MOUNT_HEADERS = new Map([...MOUNTS.map((m) => [m.dir, readCoepHeaders(m.dir)]), [rootDir, readCoepHeaders(rootDir)]]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveFile(dir, pathname) {
  let filePath = join(dir, decodeURIComponent(pathname));
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath)) {
    const fallback = join(dir, "index.html");
    return existsSync(fallback) ? fallback : null;
  }
  return filePath;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let { pathname } = url;

  // Mirror functions/_middleware.ts: redirect the bare mount path (no
  // trailing slash) to its trailing-slash form before serving — relative
  // asset URLs in the mounted app's HTML resolve against the document URL,
  // and Chrome's preload scanner ignores `<base>` entirely, so `/docs`
  // fetches assets from site root instead of `/docs/`.
  for (const { prefix } of MOUNTS) {
    if (pathname === prefix) {
      res.writeHead(308, { Location: `${prefix}/${url.search}` }).end();
      return;
    }
  }

  let dir = rootDir;
  for (const { prefix, dir: mountDir } of MOUNTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      dir = mountDir;
      pathname = pathname.slice(prefix.length) || "/";
      break;
    }
  }

  const filePath = resolveFile(dir, pathname);
  const coepHeaders = MOUNT_HEADERS.get(dir);
  res.setHeader("Cross-Origin-Opener-Policy", coepHeaders["Cross-Origin-Opener-Policy"]);
  res.setHeader("Cross-Origin-Embedder-Policy", coepHeaders["Cross-Origin-Embedder-Policy"]);

  if (!filePath) {
    res.writeHead(404).end("Not found");
    return;
  }

  const ext = extname(filePath);
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
});

for (const { dir } of [...MOUNTS, { dir: rootDir }]) {
  if (!existsSync(dir)) {
    console.error(`[preview] missing build output: ${dir} — run: pnpm turbo run build`);
    process.exit(1);
  }
}

server.listen(port, () => {
  console.log(`[preview] http://localhost:${port}  (/, /compat, /demo, /docs)`);
});
