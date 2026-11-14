import type { VfsBus } from "@bolojs/fs";
import { enrichMessage } from "@bolojs/log/error-hints";
import { buildRouteManifest, matchRoute, type RouteManifest } from "./route-manifest.js";
import { compileModule } from "./compile.js";
import { assembleDocument } from "./document.js";
import { runApiRoute } from "./api.js";
import { runGetStaticProps } from "./data.js";
import { createNextHmr, type NextHmr } from "./hmr.js";
import { NEXT_SHIMS } from "./shims.js";

export interface ModuleLoader {
  /** Import a compiled module. `servedPath` is the URL the module is (or will
   * be) served at under `base`; `code` is the compiled source. */
  load(servedPath: string, code: string): Promise<Record<string, unknown>>;
}

export interface NextDevServerOptions {
  readonly vfs: VfsBus;
  readonly root?: string;
  /** URL prefix this server is mounted at (e.g. `/__next`). */
  readonly base?: string;
  readonly hmrChannelName?: string;
  /** Pluggable ESM executor for getStaticProps/API routes. Defaults to a
   * dynamic import of the served URL in the browser, or a data: URL import
   * outside it. Inject a worker-side executor to run data code off-thread. */
  readonly moduleLoader?: ModuleLoader;
}

const GET_STATIC_PROPS_RE =
  /export\s+(?:async\s+)?(?:function|const)\s+getStaticProps|export\s*\{[^}]*\bgetStaticProps\b/;

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const defaultModuleLoader = (): ModuleLoader => ({
  load: (servedPath, code) => {
    if (typeof document !== "undefined" && typeof location !== "undefined") {
      return dynamicImport(new URL(servedPath, location.origin).href);
    }
    const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
    return dynamicImport(dataUrl);
  },
});

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".map": "application/json",
};

const PAGE_RESOLVE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

export class NextDevServer {
  private readonly vfs: VfsBus;
  private readonly root: string;
  private readonly base: string;
  private readonly loader: ModuleLoader;
  private readonly hmr: NextHmr;
  private manifestCache: { manifest: RouteManifest; at: number } | null = null;

  constructor(options: NextDevServerOptions) {
    this.vfs = options.vfs;
    this.root = options.root ?? "/project";
    this.base = options.base?.replace(/\/$/, "") ?? "/__next";
    this.loader = options.moduleLoader ?? defaultModuleLoader();
    this.hmr = createNextHmr(options.hmrChannelName ?? "next-hmr");
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.hmr.close();
  }

  handleHmr(path: string): void {
    this.hmr.broadcast({ type: "full-reload", path });
  }

  broadcastHmr(event: { type: string; path?: string }): void {
    if (event.type === "full-reload") {
      this.hmr.broadcast({ type: "full-reload", path: event.path });
    }
  }

  /** Compile a pages/ source file and return browser-ready ESM. */
  async compilePage(filePath: string): Promise<string> {
    const raw = await this.vfs.readFile(filePath);
    const { code } = await compileModule(raw as string, filePath, `${this.base}/_bolo/shims`);
    return code;
  }

  async onFetch(url: string, request: Request): Promise<Response | null> {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (!pathname.startsWith(`${this.base}/`) && pathname !== this.base) {
      return null;
    }
    const subPath = pathname.slice(this.base.length) || "/";

    try {
      if (subPath.startsWith("/_bolo/shims/")) {
        return this.serveShim(subPath.slice("/_bolo/shims/".length));
      }
      if (subPath.startsWith("/_bolo/entry")) {
        return this.serveEntry(parsed.searchParams);
      }
      if (subPath.startsWith("/_pages/")) {
        return this.serveCompiledPage(subPath.slice("/_pages/".length));
      }
      if (this.looksLikeFile(subPath)) {
        return this.serveStatic(subPath);
      }
      return this.serveRoute(subPath, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(enrichMessage(`NextDevServer error: ${message}`), {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  private serveShim(name: string): Response {
    const source = NEXT_SHIMS[name.replace(/\.js$/, "")];
    if (!source) {
      return new Response(`Unknown next shim: ${name}`, { status: 404 });
    }
    return jsResponse(source);
  }

  private async manifest(): Promise<RouteManifest> {
    const now = Date.now();
    if (this.manifestCache && now - this.manifestCache.at < 1000) {
      return this.manifestCache.manifest;
    }
    const manifest = await buildRouteManifest(this.vfs, this.root);
    this.manifestCache = { manifest, at: now };
    return manifest;
  }

  private async serveCompiledPage(rel: string): Promise<Response> {
    const relNoExt = rel.replace(/\.js$/, "");
    for (const ext of PAGE_RESOLVE_EXTENSIONS) {
      const filePath = `${this.root}/pages/${relNoExt}${ext}`;
      if (await this.vfs.exists(filePath)) {
        const code = await this.compilePage(filePath);
        return jsResponse(code);
      }
    }
    return new Response(`No page module: ${rel}`, { status: 404 });
  }

  private async serveStatic(subPath: string): Promise<Response> {
    for (const candidate of [`${this.root}/public${subPath}`, `${this.root}${subPath}`]) {
      if (await this.vfs.exists(candidate)) {
        const raw = await this.vfs.readFile(candidate);
        const ext = this.getExtension(candidate);
        return new Response(raw as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
          },
        });
      }
    }
    return new Response(`Not found: ${subPath}`, { status: 404 });
  }

  private async serveRoute(subPath: string, request: Request): Promise<Response> {
    const manifest = await this.manifest();
    const pathname = subPath === "/" ? "/" : subPath.replace(/\/$/, "");
    const apiMatch = matchRoute(manifest, pathname, "api");
    if (apiMatch) {
      return this.serveApiRoute(apiMatch.route.filePath, pathname, apiMatch.params, request);
    }
    const pageMatch = matchRoute(manifest, pathname, "page");
    if (pageMatch) {
      return this.servePage(pageMatch.route.filePath, pathname, pageMatch.params);
    }
    return new Response(`404: no route for ${pathname}`, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  private async serveApiRoute(
    filePath: string,
    pathname: string,
    params: Record<string, string | string[]>,
    request: Request,
  ): Promise<Response> {
    const code = await this.compilePage(filePath);
    const mod = await this.loader.load(`${this.base}/_pages${this.pagesRel(filePath)}.js`, code);
    const result = await runApiRoute({
      request,
      pathname,
      params,
      handler: mod.default,
    });
    const headers = new Headers(result.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "text/plain");
    }
    return new Response(result.body, { status: result.status, headers });
  }

  private async servePage(
    filePath: string,
    pathname: string,
    params: Record<string, string | string[]>,
  ): Promise<Response> {
    const manifest = await this.manifest();
    const raw = await this.vfs.readFile(filePath);
    const code = await this.compilePage(filePath);
    let pageProps: unknown = {};
    try {
      // Only execute the module server-side when it actually exports
      // getStaticProps; plain pages are rendered entirely client-side.
      if (GET_STATIC_PROPS_RE.test(raw as string)) {
        const mod = await this.loader.load(
          `${this.base}/_pages${this.pagesRel(filePath)}.js`,
          code,
        );
        if (typeof mod.getStaticProps === "function") {
          const result = await runGetStaticProps(mod, { params });
          pageProps = result.props;
        }
      }
    } catch (err) {
      return new Response(
        enrichMessage(
          `getStaticProps failed for ${pathname}: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { status: 500, headers: { "Content-Type": "text/plain" } },
      );
    }

    const pageUrl = `${this.base}/_pages${this.pagesRel(filePath)}.js`;
    const entryParams = new URLSearchParams({ page: pageUrl });
    if (manifest.appFilePath) {
      entryParams.set("app", `${this.base}/_pages${this.pagesRel(manifest.appFilePath)}.js`);
    }
    if (manifest.errorFilePath) {
      entryParams.set("error", `${this.base}/_pages${this.pagesRel(manifest.errorFilePath)}.js`);
    }
    // Slashes are legal in a query string; keeping them raw makes the
    // generated import readable and debuggable.
    const entryUrl = `${this.base}/_bolo/entry?${decodeURIComponent(entryParams.toString())}`;

    let importMapJson: string | null = null;
    try {
      if (await this.vfs.exists(`${this.root}/importmap.json`)) {
        importMapJson = (await this.vfs.readFile(`${this.root}/importmap.json`)) as string;
      }
    } catch {
      importMapJson = null;
    }

    const html = assembleDocument({
      pathname,
      pageProps,
      entryUrl,
      importMapJson,
    });
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
    });
  }

  /** Serve the generated browser entry that mounts `_app` + the page. */
  private serveEntry(searchParams: URLSearchParams): Response {
    const pageUrl = searchParams.get("page");
    if (!pageUrl) {
      return new Response("entry requires ?page=", { status: 400 });
    }
    const appUrl = searchParams.get("app");
    const appImport = appUrl
      ? `import App from ${JSON.stringify(appUrl)};`
      : `const App = ({ Component, pageProps }) =>
           __createElement(Component, pageProps ?? {});`;
    const source = `import { createElement as __createElement } from "react";
import { createRoot } from "react-dom/client";
import { setBoloRouterState } from ${JSON.stringify(`${this.base}/_bolo/shims/router.js`)};
${appImport}
import Page from ${JSON.stringify(pageUrl)};

export async function boot(pathname, pageProps) {
  setBoloRouterState({ pathname, asPath: pathname, query: {}, params: {} });
  const root = createRoot(document.getElementById("__next"));
  root.render(__createElement(App, { Component: Page, pageProps: pageProps ?? {} }));
}
`;
    return jsResponse(source);
  }

  /** pages/-relative URL path of a source file: `/home/web/pages/a/[id].tsx`
   * -> `/a/[id]` (extension is re-added by callers). */
  private pagesRel(filePath: string): string {
    const rel = filePath.slice(`${this.root}/pages`.length);
    return rel.replace(/\.[^./\\]+$/, "");
  }

  private looksLikeFile(subPath: string): boolean {
    return /\.[a-z0-9]+$/i.test(subPath) && !subPath.startsWith("/_bolo/");
  }

  private getExtension(filePath: string): string {
    const dotIdx = filePath.lastIndexOf(".");
    if (dotIdx === -1) return "";
    const slashIdx = filePath.lastIndexOf("/");
    if (dotIdx < slashIdx) return "";
    return filePath.slice(dotIdx);
  }
}

const jsResponse = (code: string): Response =>
  new Response(code, {
    status: 200,
    headers: { "Content-Type": "application/javascript", "Cache-Control": "no-cache" },
  });
