// Tiny static + dynamic server for the R0 spikes. Serves:
//   /a/...  -> spikes/a-worker-sw/public
//   /b/...  -> spikes/b-sync-xhr/public  (+ dynamic /b/sync endpoint)
//   /c/...  -> spikes/c-dip-embed/public (embed.html gets Document-Isolation-Policy)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const mounts: Record<string, string> = {
  "/a/": "a-worker-sw/public",
  "/b/": "b-sync-xhr/public",
  "/c/": "c-dip-embed/public",
};

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

// Per-path response headers. Everything else is served with no-store only.
const headerRules: Record<string, Record<string, string>> = {
  "/c/embed.html": {
    "Document-Isolation-Policy": "isolate-and-credentialless",
  },
  "/c/embed-coop-coep.html": {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  },
};

export const createSpikeServer = (port: number) => {
  const netlog: { url: string; via: string | null }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = normalize(url.pathname);
    netlog.push({ url: url.pathname + url.search, via: (req.headers["service-worker"] as string) ?? null });
    if (path === "/__netlog") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(netlog));
      return;
    }

    const fail = (code: number, msg: string) => {
      res.writeHead(code, { "Content-Type": "text/plain" });
      res.end(msg);
    };

    // Dynamic fallback for spike (b): if a sync XHR reaches the network
    // instead of the ServiceWorker, it lands here and is marked NET:.
    if (path === "/b/sync") {
      const size = Number(url.searchParams.get("size") ?? 16);
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("NET:" + "y".repeat(Math.max(0, size - 4)));
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<a href='/a/index.html'>spike a</a> " +
          "<a href='/b/index.html'>spike b</a> " +
          "<a href='/c/embed.html'>spike c</a>",
      );
      return;
    }

    const prefix = Object.keys(mounts).find((m) => path.startsWith(m));
    if (!prefix) return fail(404, "no mount " + path);
    const file = join(root, mounts[prefix], path.slice(prefix.length));
    readFile(file)
      .then((body) => {
        res.writeHead(200, {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
          ...(headerRules[path] ?? {}),
        });
        res.end(body);
      })
      .catch(() => fail(404, "not found " + path));
  });
  server.listen(port);
  return server;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 5311);
  createSpikeServer(port);
  console.log(`spike server on :${port}`);
}
