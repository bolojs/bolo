// ponytail: hardcode CDN versions — update on package.json version bump
const ESBUILD_VERSION = "0.20.2";
const SWC_VERSION = "1.15.24";

const CDN_BASE = "https://cdn.jsdelivr.net/npm/";

interface BinaryManifest {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly cdnUrl: string;
}

export const BINARY_MANIFEST: readonly BinaryManifest[] = [
  {
    name: "esbuild-wasm",
    version: ESBUILD_VERSION,
    filename: "esbuild.wasm",
    cdnUrl: `${CDN_BASE}esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`,
  },
  {
    name: "@swc/wasm-web",
    version: SWC_VERSION,
    filename: "wasm_bg.wasm",
    cdnUrl: `${CDN_BASE}@swc/wasm-web@${SWC_VERSION}/wasm_bg.wasm`,
  },
] as const;

const memoryCache = new Map<string, Uint8Array>();

const cachePath = (name: string, version: string, filename: string): string =>
  `/__wasm-cache/${name}@${version}/${filename}`;

interface VfsBridge {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir?(path: string): Promise<string[]>;
}

const getVfs = (): VfsBridge | undefined => (globalThis as any).__vfsBus;

/**
 * Load a WASM binary with 2-tier cache: in-memory → OPFS → CDN.
 * On first CDN fetch, stores in OPFS for offline use ("install once, stay local").
 */
export const loadBinary = async (
  name: string,
  version: string,
  filename: string,
): Promise<Uint8Array> => {
  const key = `${name}@${version}/${filename}`;

  // 1. In-memory
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const path = cachePath(name, version, filename);
  const vfs = getVfs();

  // 2. OPFS persistent cache
  if (vfs) {
    try {
      if (await vfs.exists(path)) {
        const data = await vfs.readFile(path);
        const bytes = data instanceof Uint8Array ? data : new Uint8Array();
        if (bytes.length > 0) {
          memoryCache.set(key, bytes);
          return bytes;
        }
      }
    } catch {
      // VFS error — fall through to CDN
    }
  }

  // 3. CDN fetch
  const entry = BINARY_MANIFEST.find((m) => m.name === name && m.version === version);
  const url = entry?.cdnUrl ?? `${CDN_BASE}${name}@${version}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch WASM binary ${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // 4. Store in OPFS + memory
  if (vfs) {
    try {
      const dir = `/__wasm-cache/${name}@${version}`;
      if (!(await vfs.exists(dir))) await vfs.mkdir(dir, { recursive: true });
      await vfs.writeFile(path, bytes);
    } catch {
      // Cache write failed — continue, binary is in memory
    }
  }
  memoryCache.set(key, bytes);
  return bytes;
};

/** Fetch all binaries from CDN and cache them. Call during app boot or "install" UX. */
export const precacheAll = async (): Promise<void> => {
  await Promise.all(BINARY_MANIFEST.map((m) => loadBinary(m.name, m.version, m.filename)));
};

/** Check if all manifest binaries are cached in OPFS. */
export const isInstalled = async (): Promise<boolean> => {
  const vfs = getVfs();
  if (!vfs) return false;
  for (const m of BINARY_MANIFEST) {
    try {
      if (!(await vfs.exists(cachePath(m.name, m.version, m.filename)))) return false;
    } catch {
      return false;
    }
  }
  return true;
};

/** Delete OPFS cache entries not in the manifest (old versions). */
export const pruneCache = async (): Promise<void> => {
  const vfs = getVfs();
  if (!vfs) return;
  try {
    if (!(await vfs.exists("/__wasm-cache"))) return;
    const entries = (await (vfs as any).readdir("/__wasm-cache")) as string[];
    const valid = new Set(BINARY_MANIFEST.map((m) => `${m.name}@${m.version}`));
    for (const entry of entries) {
      if (!valid.has(entry)) {
        await vfs.rm(`/__wasm-cache/${entry}`, { recursive: true }).catch(() => {});
      }
    }
  } catch {
    // pruning is best-effort
  }
};
