import type { VfsBus } from "@bolojs/fs";

export const PAGE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"] as const;
export const API_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx"] as const;

/** Special files inside pages/ that are routes themselves, not pages. */
const CONVENTION_FILES = new Set(["_app", "_document", "_error"]);

export type RouteKind = "page" | "api";

export interface RouteEntry {
  /** URL pathname this route answers, e.g. `/blog/[id]`. */
  readonly path: string;
  /** VFS path of the source file, e.g. `/home/web/pages/blog/[id].tsx`. */
  readonly filePath: string;
  readonly kind: RouteKind;
  /** Param names in order of appearance, e.g. `["id"]` for `/blog/[id]`. */
  readonly paramNames: readonly string[];
  /** True when the last segment is a catch-all (`[...slug]`). */
  readonly catchAll: boolean;
}

export interface RouteManifest {
  readonly routes: readonly RouteEntry[];
  readonly appFilePath: string | null;
  readonly documentFilePath: string | null;
  readonly errorFilePath: string | null;
}

interface DirEnt {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

const isDirent = (value: unknown): value is DirEnt => {
  return (
    typeof value === "object" && value !== null && typeof (value as DirEnt).isFile === "function"
  );
};

const stripExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

const hasPageExtension = (name: string): boolean =>
  (PAGE_EXTENSIONS as readonly string[]).some((ext) => name.endsWith(ext));

const segmentParams = (segment: string): { name: string; catchAll: boolean } | null => {
  const match = /^\[\.\.\.(.+)\]$/.exec(segment);
  if (match) return { name: match[1], catchAll: true };
  const dyn = /^\[(.+)\]$/.exec(segment);
  if (dyn) return { name: dyn[1], catchAll: false };
  return null;
};

/** Convert a pages-relative file path into a route path with param segments. */
export const fileToRoutePath = (pagesRelPath: string): string => {
  const withoutExt = pagesRelPath.replace(/\.[^./\\]+$/, "");
  const segments = withoutExt.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "index") segments.pop();
  return "/" + segments.join("/");
};

export const collectParams = (
  route: RouteEntry,
  pathname: string,
): Record<string, string | string[]> => {
  const routeSegments = route.path.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  const params: Record<string, string | string[]> = {};
  let i = 0;
  let j = 0;
  while (i < routeSegments.length) {
    const seg = routeSegments[i];
    const param = segmentParams(seg);
    if (param) {
      if (param.catchAll) {
        params[param.name] = pathSegments.slice(j);
        j = pathSegments.length;
      } else {
        params[param.name] = pathSegments[j] ?? "";
        j += 1;
      }
    } else {
      j += 1;
    }
    i += 1;
  }
  return params;
};

/** Per-segment rank. Only absent-vs-catch-all is ever compared at a position
 * (catch-alls are always trailing, so static/dynamic never compete with
 * absent), and the ended route must win there: `/blog` beats
 * `/blog/[...slug]` for the `/blog` pathname. */
const segmentKindScore = (segment: string | undefined): number => {
  if (segment === undefined) return 2;
  const param = segmentParams(segment);
  if (!param) return 4;
  return param.catchAll ? 1 : 3;
};

/** Per-segment comparison: at each position static > dynamic > catch-all >
 * absent. Used to sort candidates so `/blog` beats `/blog/[...slug]` for the
 * `/blog` pathname. */
export const compareRoutes = (a: RouteEntry, b: RouteEntry): number => {
  const aSegs = a.path.split("/").filter(Boolean);
  const bSegs = b.path.split("/").filter(Boolean);
  const len = Math.max(aSegs.length, bSegs.length);
  for (let i = 0; i < len; i += 1) {
    const diff = segmentKindScore(bSegs[i]) - segmentKindScore(aSegs[i]);
    if (diff !== 0) return diff;
  }
  return bSegs.length - aSegs.length;
};

/** Specificity score for route sorting; higher wins. Mirrors Next's ranking:
 * static > dynamic > catch-all, and more segments win at the same kind. */
export const routeScore = (route: RouteEntry): number => {
  const segments = route.path.split("/").filter(Boolean);
  let score = 0;
  for (const seg of segments) {
    score *= 10;
    score += segmentKindScore(seg);
  }
  return score;
};

export const matchRoute = (
  manifest: RouteManifest,
  pathname: string,
  kind?: RouteKind,
): { route: RouteEntry; params: Record<string, string | string[]> } | null => {
  const candidates = manifest.routes
    .filter((r) => (kind ? r.kind === kind : true))
    .slice()
    .sort(compareRoutes);

  for (const route of candidates) {
    const routeSegments = route.path.split("/").filter(Boolean);
    const pathSegments = pathname.split("/").filter(Boolean);
    if (routeSegments.length !== pathSegments.length && !route.catchAll) continue;
    if (route.catchAll && pathSegments.length < routeSegments.length - 1) continue;
    let ok = true;
    for (let i = 0; i < routeSegments.length; i += 1) {
      const param = segmentParams(routeSegments[i]);
      if (param?.catchAll) continue;
      if (!param && routeSegments[i] !== pathSegments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params: collectParams(route, pathname) };
  }
  return null;
};

const findConventionFile = async (
  vfs: VfsBus,
  pagesDir: string,
  name: string,
): Promise<string | null> => {
  for (const ext of PAGE_EXTENSIONS) {
    const candidate = `${pagesDir}/${name}${ext}`;
    if (await vfs.exists(candidate)) return candidate;
  }
  return null;
};

/** Scan `pages/` in the VFS and build the route table. */
export const buildRouteManifest = async (vfs: VfsBus, root: string): Promise<RouteManifest> => {
  const pagesDir = `${root}/pages`;
  const routes: RouteEntry[] = [];

  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: string[] | DirEnt[];
    try {
      entries = (await vfs.readdir(dir, { withFileTypes: true })) as DirEnt[] | string[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const fileName = isDirent(entry) ? entry.name : String(entry);
      const isFile = isDirent(entry) ? entry.isFile() : true;
      const isDirectory = isDirent(entry) ? entry.isDirectory() : false;
      if (isDirectory) {
        await walk(`${dir}/${fileName}`, rel ? `${rel}/${fileName}` : fileName);
        continue;
      }
      if (!isFile || !hasPageExtension(fileName)) continue;
      const stem = stripExtension(fileName);
      const relPath = rel ? `${rel}/${fileName}` : fileName;
      const filePath = `${pagesDir}/${relPath}`;
      if (CONVENTION_FILES.has(stem) && !rel) continue;
      const routePath = fileToRoutePath(relPath);
      const segments = routePath.split("/").filter(Boolean);
      const paramNames: string[] = [];
      let catchAll = false;
      for (const seg of segments) {
        const param = segmentParams(seg);
        if (param) {
          paramNames.push(param.name);
          if (param.catchAll) catchAll = true;
        }
      }
      const isApi = segments[0] === "api";
      routes.push({
        path: routePath,
        filePath,
        kind: isApi ? "api" : "page",
        paramNames,
        catchAll,
      });
    }
  };

  await walk(pagesDir, "");

  routes.sort(compareRoutes);

  return {
    routes,
    appFilePath: await findConventionFile(vfs, pagesDir, "_app"),
    documentFilePath: await findConventionFile(vfs, pagesDir, "_document"),
    errorFilePath: await findConventionFile(vfs, pagesDir, "_error"),
  };
};
