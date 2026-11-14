import { getLogger } from "@bolojs/log/browser";
import { schemas, type RouteModule } from "./contract";

/**
 * The /app backend: a plain fetch handler, not a node process. Route modules
 * are plain JavaScript files in the container VFS, re-imported from fresh
 * blob URLs on every reload, so an editor save becomes visible to the next
 * request with no bundling step and no restart. Requests arrive from the
 * page as same-origin fetches to /__virtual__/<port>/*, are intercepted by
 * the sw-sandbox service worker, and are dispatched to the handler
 * registered on the booted container's SWSandbox.
 */

export const VIRTUAL_PORT = 8787;
export const VIRTUAL_BASE = `/__virtual__/${VIRTUAL_PORT}`;

const logger = getLogger(["bolo", "site-landing", "subsite", "app"]);

export interface BackendFs {
  readFile(path: string): Promise<string>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface RouteSummary {
  method: string;
  path: string;
  file: string;
}

interface LoadedRoute extends RouteSummary {
  module: RouteModule;
}

const jsonError = (status: number, message: string) =>
  Response.json({ error: message }, { status });

const matchPath = (pattern: string, pathname: string): Record<string, string> | null => {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (part !== pathParts[i]) {
      return null;
    }
  }
  return params;
};

export class AppBackend {
  private routes: LoadedRoute[] = [];
  private blobs: string[] = [];

  constructor(
    private readonly fs: BackendFs,
    private readonly routesDir: string,
  ) {}

  /** (Re)load every route module under routesDir from the current VFS text. */
  async reload(): Promise<RouteSummary[]> {
    const entries = (await this.fs.readdir(this.routesDir)) as string[];
    const files = entries.filter((name) => name.endsWith(".js")).sort();
    const loaded: LoadedRoute[] = [];
    const newBlobs: string[] = [];
    for (const name of files) {
      const file = `${this.routesDir.replace(/\/$/, "")}/${name}`;
      const source = await this.fs.readFile(file);
      const blobUrl = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      newBlobs.push(blobUrl);
      try {
        const mod = (await import(/* @vite-ignore */ blobUrl)) as {
          default?: RouteModule;
        };
        const route = mod.default;
        if (!route || typeof route.handler !== "function" || !route.path) {
          logger.error("route module missing default export", { file });
          continue;
        }
        loaded.push({
          method: route.method,
          path: route.path,
          file,
          module: route,
        });
      } catch (err) {
        logger.error("route module failed to load", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const blob of this.blobs) URL.revokeObjectURL(blob);
    this.blobs = newBlobs;
    this.routes = loaded;
    return this.list();
  }

  list(): RouteSummary[] {
    return this.routes.map(({ method, path, file }) => ({ method, path, file }));
  }

  /**
   * Handle one intercepted request. The caller strips the
   * /__virtual__/<port> prefix before invoking; the full original request is
   * handed to the matched route handler.
   */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith(VIRTUAL_BASE)
      ? url.pathname.slice(VIRTUAL_BASE.length) || "/"
      : url.pathname;
    const route = this.routes.find(
      (r) => r.module.method === request.method && matchPath(r.module.path, pathname),
    );
    if (!route) {
      return jsonError(404, `no route for ${request.method} ${pathname}`);
    }
    try {
      const params = matchPath(route.module.path, pathname) ?? {};
      return await route.module.handler(request, { params, schemas });
    } catch (err) {
      logger.error("route handler threw", {
        path: route.module.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(500, err instanceof Error ? err.message : "handler threw");
    }
  }
}
