import type { VfsBus } from "@bolojs/fs";

/**
 * Route-file persistence for /app. The container VFS is memory-first; the
 * VfsBus cold tier does not rehydrate a fresh page's hot tier reliably, so
 * /app owns an explicit snapshot: on every applied save the route files are
 * taken from VfsBus.snapshot() and written as one JSON document into OPFS,
 * and on boot that document seeds the VFS before the starters do.
 */

const DIR = "bolo-app";
const FILE = "routes.json";

export type RouteSnapshot = Record<string, string>;

const opfsRoot = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return (await navigator.storage?.getDirectory?.()) ?? null;
  } catch {
    return null;
  }
};

/** Pick the route files (absolute path -> text) out of a VfsBus snapshot. */
export const routeSnapshot = (vfs: VfsBus, routesDir: string): RouteSnapshot => {
  const prefix = `${routesDir.replace(/\/$/, "")}/`;
  const out: RouteSnapshot = {};
  for (const [path, contents] of Object.entries(vfs.snapshot())) {
    if (path.startsWith(prefix) && typeof contents === "string") out[path] = contents;
  }
  return out;
};

export const saveRouteSnapshot = async (snapshot: RouteSnapshot): Promise<void> => {
  const root = await opfsRoot();
  if (!root) return;
  try {
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const handle = await dir.getFileHandle(FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(snapshot));
    await writable.close();
  } catch {
    // OPFS unavailable or quota exceeded: the session keeps working in memory.
  }
};

export const loadRouteSnapshot = async (): Promise<RouteSnapshot | null> => {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const dir = await root.getDirectoryHandle(DIR);
    const file = await (await dir.getFileHandle(FILE)).getFile();
    const parsed: unknown = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object") return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string",
    ) as [string, string][];
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
};

export const clearRouteSnapshot = async (): Promise<void> => {
  const root = await opfsRoot();
  if (!root) return;
  try {
    await root.removeEntry(DIR, { recursive: true });
  } catch {
    // Nothing saved yet.
  }
};
