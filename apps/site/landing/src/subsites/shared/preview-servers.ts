import { BrowserViteServer } from "@bolojs/vite-server";
import { NextDevServer } from "@bolojs/next-server";
import { SWSandbox } from "@bolojs/sandbox";
import type { VfsBus } from "@bolojs/fs";

export const VITE_PREVIEW_BASE = "/__preview/";
export const NEXT_PREVIEW_BASE = "/__next/";
export const PREVIEW_SW_PATH = "/sw.js";

export interface PreviewServers {
  vite: BrowserViteServer;
  next: NextDevServer;
  sandbox: SWSandbox;
}

/**
 * Serve preview iframes (root-SW scope) through dedicated dev servers.
 *
 * The subsite SW ("/ide/sw.js", "/vibe/sw.js", …) only controls its own
 * scope, so preview iframe navigations to "/__preview/" or "/__next/" would
 * bypass it entirely. The page therefore pairs with the root SW ("/sw.js")
 * and routes those prefixes to a BrowserViteServer / NextDevServer running
 * in the page over the same VfsBus.
 */
export const startPreviewServers = async (
  vfs: VfsBus,
  workdir: string,
): Promise<PreviewServers> => {
  const vite = new BrowserViteServer({ vfs, root: workdir, base: VITE_PREVIEW_BASE });
  await vite.start();
  const next = new NextDevServer({
    vfs,
    root: workdir,
    base: NEXT_PREVIEW_BASE.replace(/\/$/, ""),
  });
  await next.start();
  const sandbox = await SWSandbox.create({
    origin: globalThis.location.origin,
    swPath: PREVIEW_SW_PATH,
  });
  const withIsolationHeaders = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  sandbox.onFetch(async (req) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith(VITE_PREVIEW_BASE)) {
      const serverUrl = new URL(req.url);
      serverUrl.pathname = url.pathname.replace(/^\/(__preview)/, "") || "/";
      return withIsolationHeaders(await vite.onFetch(serverUrl.toString(), req));
    }
    if (url.pathname.startsWith(NEXT_PREVIEW_BASE)) {
      const response = await next.onFetch(req.url, req);
      if (response) return withIsolationHeaders(response);
    }
    throw new Error("not handled");
  });
  return { vite, next, sandbox };
};

/**
 * The initial "server-ready" fires during boot before listeners attach, so
 * poll the preview servers in-page until one actually serves HTML, then
 * return the (SW-controlled) URL for the iframe.
 *
 * A fetch() to "/__preview/" is a subresource request on a page controlled
 * by the subsite-scoped SW ("/ide/" etc.), so it bypasses the root SW
 * entirely and 404s. The preview servers live in this page — probe them
 * directly and keep the network URL only for the iframe.
 */
export const waitForPreview = async (servers: PreviewServers, base: string): Promise<string> => {
  const url = new URL(base, globalThis.location.origin).href;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const isNext = base.startsWith(NEXT_PREVIEW_BASE);
      let probeUrl = url;
      if (!isNext) {
        const stripped = new URL(url);
        stripped.pathname = stripped.pathname.replace(/^\/__preview/, "") || "/";
        probeUrl = stripped.toString();
      }
      const probe = new Request(probeUrl, { cache: "no-store" });
      const response = isNext
        ? await servers.next.onFetch(url, probe)
        : await servers.vite.onFetch(probeUrl, probe);
      const body = response ? await response.text() : "";
      if (response?.status === 200 && body.includes("<")) {
        return url;
      }
    } catch {
      // Server not ready yet; retry.
    }
    if (Date.now() > deadline) {
      throw new Error("Preview server did not serve HTML within 30s");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};
