import type { VfsBus } from "@bolojs/vfs-bus";
import type { Plugin } from "@rolldown/browser";
import { buildEsmShUrl } from "@bolojs/npm";

declare global {
  // Set by a host app (see apps/compat-harness/src/main.ts) to load
  // rolldown/browser + oxc-transform as bare specifiers — bundled/served by
  // the host's own dev server from node_modules — instead of from esm.sh.
  // esm.sh-hosted @rolldown/browser panics in real browsers: its WASI worker
  // pool does `new Worker(new URL('./wasi-worker-browser.mjs',
  // import.meta.url))` with no `{ type: 'module' }`, and classic workers can
  // never load a cross-origin script (no CORS override exists), so the CDN's
  // own origin breaks it. Both packages are real (dev)dependencies of this
  // package already; apps that don't ship this bundler to end users (internal
  // QA tools, not size-sensitive) can opt into serving them locally, same-
  // origin, instead of trading correctness for a smaller production bundle.
  // Left unset, apps keep the prior CDN behavior.
  //
  // Per-package flags exist for static-build hosts (e.g. apps/site/demo) that
  // bundle only rolldown/browser same-origin but still want oxc-transform from
  // the CDN. The aggregate `__preferLocalBundler` still drives both for
  // dev-server hosts such as compat-harness.
  var __preferLocalBundler: boolean | undefined;
  var __preferLocalRolldown: boolean | undefined;
  var __preferLocalOxc: boolean | undefined;
}

const preferLocalRolldown = () =>
  Boolean(
    globalThis.process?.versions?.node ||
    globalThis.__preferLocalBundler ||
    globalThis.__preferLocalRolldown,
  );
const preferLocalOxc = () =>
  Boolean(
    globalThis.process?.versions?.node ||
    globalThis.__preferLocalBundler ||
    globalThis.__preferLocalOxc,
  );

// rolldown/browser: lazy CDN load with Node.js/local-bundler fallback
let _rolldown: Promise<typeof import("@rolldown/browser")> | undefined;
const getRolldown = () => {
  if (!_rolldown) {
    _rolldown = preferLocalRolldown()
      ? import("@rolldown/browser")
      : // @ts-ignore: runtime CDN URL, not resolvable by TypeScript
        import(/* @vite-ignore */ "https://esm.sh/@rolldown/browser@latest");
  }
  return _rolldown;
};

// oxc-transform: lazy CDN load with Node.js/local-bundler fallback.
//
// ponytail: oxc-transform's package.json has no `exports` field — only old-
// style `main` + `browser`. Vite/rollup need `exports` to rewrite a dynamic
// `import("oxc-transform")` into a chunk URL; without it the bare specifier
// survives the build and the runtime tries to fetch `/oxc-transform`, which
// fails on real origins (no dev-server resolver, no `/oxc-transform` route).
// Static import side-steps the entire class: bundle.ts is a leaf dep and
// oxc-transform/browser.js is a 51-byte re-export of the binding — the heavy
// WASM only loads lazily when `.transform()` is actually called.
import * as _oxcLocal from "oxc-transform";

let _oxc: Promise<typeof import("oxc-transform")> | undefined;
// ponytail: warning is one-shot at first import, no logger dep needed —
// console.warn is greppable and the obs buffer picks it up via main-thread
// window onerror. Promote to logtape when this becomes a hot path.
let _oxcCdnWarned = false;
const warnOxcCdn = (): void => {
  if (_oxcCdnWarned) return;
  _oxcCdnWarned = true;
  if (
    typeof console !== "undefined" &&
    typeof location !== "undefined" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1"
  ) {
    console.warn(
      "[wasm-registry] oxc-transform: using esm.sh CDN. " +
        "Cross-origin Worker construction may fail on deployed origins. " +
        "Set __preferLocalBundler (or __preferLocalOxc) and add noExternal for oxc-transform " +
        "in the consumer's vite.config — see examples/app-builder/vite.config.ts.",
    );
  }
};
const getOxc = (): Promise<typeof import("oxc-transform")> => {
  if (!_oxc) {
    if (preferLocalOxc()) {
      _oxc = Promise.resolve(_oxcLocal);
    } else {
      warnOxcCdn();
      // @ts-ignore: runtime CDN URL, not resolvable by TypeScript
      _oxc = import(/* @vite-ignore */ "https://esm.sh/oxc-transform@latest");
    }
  }
  return _oxc;
};

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

// Builtins with a browser shim available somewhere in the host realm (either
// stateless, from `node-web-shims`, or host-bound, from `node-runtime-shims`).
// Resolution of the *live* value happens via `getShim` at bundle time — this
// package only knows the builtin's name, not its implementation.
const NODE_BUILTIN_NAMES = new Set([
  "fs",
  "http",
  "https",
  "net",
  "child_process",
  "path",
  "buffer",
  "url",
  "crypto",
  "os",
  "events",
  "stream",
  "util",
  "async_hooks",
  "querystring",
  "worker_threads",
  "string_decoder",
  "tty",
  "assert",
  "zlib",
  "constants",
  "perf_hooks",
  "timers",
  "timers/promises",
  "punycode",
  "process",
  "module",
  "diagnostics_channel",
  "readline",
]);

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Maps a JSR specifier to its npm-compatibility mirror name.
 * `jsr:@scope/name` -> `@jsr/scope__name`; `jsr:name` -> `@jsr/name`.
 * Subpaths are preserved relative to the mirror package.
 */
export const mapJsrSpecifier = (specifier: string): string => {
  const inner = specifier.slice("jsr:".length);
  if (inner.startsWith("@")) {
    return `@jsr/${inner.slice(1).replace("/", "__")}`;
  }
  return `@jsr/${inner}`;
};

export interface BundleEntryOptions {
  readonly vfs: VfsBus;
  /** Working directory used to resolve the entry point; defaults to `/`. */
  readonly cwd?: string;
  /**
   * Returns the live shim instance (a plain object of its module exports) for
   * a node builtin name (without the `node:` prefix), or `undefined` if this
   * host realm has no shim for it — the import is then left external with a
   * warning rather than failing the whole bundle.
   */
  readonly getShim?: (builtin: string) => Record<string, unknown> | undefined;
}

export interface BundleEntryResult {
  readonly code: string;
  readonly warnings: string[];
}

const dirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
};

const extname = (path: string): string => {
  const dotIdx = path.lastIndexOf(".");
  const slashIdx = path.lastIndexOf("/");
  return dotIdx > slashIdx ? path.slice(dotIdx) : "";
};

const joinPath = (...parts: string[]): string => {
  const segments: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
};

const isFile = (vfs: VfsBus, path: string): boolean => {
  try {
    return vfs.hot.statSync(path).isFile();
  } catch {
    return false;
  }
};

// Real Node module resolution follows symlinks before computing a module's
// own `__dirname` (unless run with `--preserve-symlinks`), which is exactly
// what lets pnpm-style virtual stores work: a package resolved through a
// symlink still does its OWN further `node_modules` lookups from its real,
// nested store directory rather than the symlink's flat location. Since our
// own directory walk (`findPackageDir`) is plain string `dirname()`, it must
// see the same real path or it walks back up the symlink's flat ancestry
// instead of the store's nested one — so every resolved id is realpath'd here.
const resolveFile = (vfs: VfsBus, base: string): string | undefined => {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) {
      return vfs.hot.realpathSync(candidate) as string;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (ext === "") continue;
    const candidate = joinPath(base, "index" + ext);
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) {
      return vfs.hot.realpathSync(candidate) as string;
    }
  }
  return undefined;
};

const findPackageDir = (vfs: VfsBus, fromDir: string, name: string): string | undefined => {
  let dir = fromDir;
  for (;;) {
    const candidate = joinPath(dir, "node_modules", name);
    if (vfs.hot.existsSync(candidate)) return candidate;
    if (dir === "/") return undefined;
    dir = dirname(dir);
  }
};

const readPackageJson = (vfs: VfsBus, pkgDir: string): Record<string, unknown> => {
  const pkgJsonPath = joinPath(pkgDir, "package.json");
  if (!vfs.hot.existsSync(pkgJsonPath)) return {};
  return JSON.parse(vfs.hot.readFileSync(pkgJsonPath, "utf8") as string);
};

// Condition priority for `exports`/`imports` resolution. We're always bundling
// ESM for a browser platform, so `browser` (bundler-specific but ubiquitous)
// wins, then `import`/`module`, then `default` — `require`/`node` are never
// picked since we never want the CJS or server-only branch of a dual package.
const CONDITIONS = ["browser", "import", "module", "default"];

// Resolves an `exports`/`imports` target, which per spec can be a string, a
// conditions object (checked in `CONDITIONS` order, recursing into nested
// condition objects), or an array of alternatives tried in order until one
// resolves — `null` anywhere in the chain means "explicitly unavailable".
const resolveExportTarget = (target: unknown): string | undefined => {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveExportTarget(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (target && typeof target === "object") {
    const map = target as Record<string, unknown>;
    for (const condition of CONDITIONS) {
      if (condition in map) {
        const resolved = resolveExportTarget(map[condition]);
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
};

// Matches a subpath (e.g. `lib/foo`) against an `exports`/`imports` pattern key
// (e.g. `./lib/*` or `#internal/*.js`, prefix stripped by the caller), returning
// the wildcard capture, or `''` for an exact non-wildcard match, else `undefined`.
const matchSubpathPattern = (pattern: string, subpath: string): string | undefined => {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) return pattern === subpath ? "" : undefined;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (subpath.length < prefix.length + suffix.length) return undefined;
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return undefined;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
};

// Finds the best (longest-prefix) match for `subpath` among a map's `./`- or
// `#`-prefixed keys, per the `exports`/`imports` pattern-matching algorithm.
const findBestSubpathMatch = (
  map: Record<string, unknown>,
  keyPrefix: string,
  subpath: string,
): { target: unknown; capture: string } | undefined => {
  const exactKey = `${keyPrefix}${subpath}`;
  if (exactKey in map) return { target: map[exactKey], capture: "" };

  let best: { key: string; capture: string } | undefined;
  for (const key of Object.keys(map)) {
    if (!key.startsWith(keyPrefix)) continue;
    const capture = matchSubpathPattern(key.slice(keyPrefix.length), subpath);
    if (capture !== undefined && (!best || key.length > best.key.length)) best = { key, capture };
  }
  return best ? { target: map[best.key], capture: best.capture } : undefined;
};

const resolveMapSubpath = (
  vfs: VfsBus,
  pkgDir: string,
  map: Record<string, unknown>,
  subpath: string,
): string | undefined => {
  const match = findBestSubpathMatch(map, "./", subpath);
  if (!match) return undefined;
  const targetPath = resolveExportTarget(match.target)?.replace("*", match.capture);
  if (!targetPath) return undefined;
  return resolveFile(vfs, joinPath(pkgDir, targetPath));
};

/**
 * Resolves a package-internal `#subpath` import (the `imports` field) against
 * the nearest ancestor package.json — these are always resolved relative to
 * the *importing* file's own package, never the package being imported.
 */
const resolvePackageImportsSubpath = (
  vfs: VfsBus,
  importerFile: string,
  specifier: string,
): string | undefined => {
  const owningDir = findOwningPackageDir(vfs, dirname(importerFile));
  if (!owningDir) return undefined;
  const pkgJson = readPackageJson(vfs, owningDir);
  const importsMap = pkgJson.imports as unknown;
  if (!importsMap || typeof importsMap !== "object") return undefined;
  const match = findBestSubpathMatch(
    importsMap as Record<string, unknown>,
    "#",
    specifier.slice(1),
  );
  if (!match) return undefined;
  const targetPath = resolveExportTarget(match.target)?.replace("*", match.capture);
  return targetPath ? resolveFile(vfs, joinPath(owningDir, targetPath)) : undefined;
};

const findOwningPackageDir = (vfs: VfsBus, fromDir: string): string | undefined => {
  let dir = fromDir;
  for (;;) {
    if (vfs.hot.existsSync(joinPath(dir, "package.json"))) return dir;
    if (dir === "/") return undefined;
    dir = dirname(dir);
  }
};

/**
 * Applies a package's `browser` field remap to a specifier written inside one
 * of its own files (bare deps and relative paths alike) — the standard
 * browserify/webpack convention most bundler-aware packages still ship for
 * platform-specific swaps (e.g. `"./node-only.js": "./browser-only.js"` or
 * `"fs": false` to stub a module out entirely). Returns `false` for an
 * explicit stub, a replacement specifier, or `undefined` if unmapped.
 */
const applyBrowserFieldRemap = (
  vfs: VfsBus,
  importerFile: string,
  specifier: string,
): string | false | undefined => {
  const owningDir = findOwningPackageDir(vfs, dirname(importerFile));
  if (!owningDir) return undefined;
  const browserField = readPackageJson(vfs, owningDir).browser;
  if (!browserField || typeof browserField !== "object") return undefined;
  const map = browserField as Record<string, unknown>;
  const candidates = specifier.startsWith(".")
    ? [joinPath(dirname(importerFile), specifier), specifier]
    : [specifier];
  for (const candidate of candidates) {
    if (candidate in map) {
      const value = map[candidate];
      return value === false ? false : typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
};

const resolveBarePackage = (
  vfs: VfsBus,
  fromDir: string,
  specifier: string,
): string | undefined => {
  const isScoped = specifier.startsWith("@");
  const parts = specifier.split("/");
  const name = isScoped ? parts.slice(0, 2).join("/") : parts[0];
  const subpath = (isScoped ? parts.slice(2) : parts.slice(1)).join("/");
  const pkgDir = findPackageDir(vfs, fromDir, name);
  if (!pkgDir) return undefined;

  const pkgJson = readPackageJson(vfs, pkgDir);
  const exportsMap = pkgJson.exports as unknown;

  if (subpath) {
    if (exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap)) {
      const resolved = resolveMapSubpath(
        vfs,
        pkgDir,
        exportsMap as Record<string, unknown>,
        subpath,
      );
      if (resolved) return resolved;
    }
    return resolveFile(vfs, joinPath(pkgDir, subpath));
  }

  if (exportsMap) {
    const dotExport =
      typeof exportsMap === "string" || Array.isArray(exportsMap)
        ? exportsMap
        : ((exportsMap as Record<string, unknown>)["."] ?? exportsMap);
    const targetPath = resolveExportTarget(dotExport);
    if (targetPath) {
      const resolved = resolveFile(vfs, joinPath(pkgDir, targetPath));
      if (resolved) return resolved;
    }
  }

  const browserMain = typeof pkgJson.browser === "string" ? pkgJson.browser : undefined;
  const mainField =
    browserMain ?? (pkgJson.module as string) ?? (pkgJson.main as string) ?? "index.js";
  return (
    resolveFile(vfs, joinPath(pkgDir, mainField)) ?? resolveFile(vfs, joinPath(pkgDir, "index"))
  );
};

const GLOBALS_BANNER = `
var __bcGlobals = () => globalThis.__browserContainers;
var process = __bcGlobals()?.shims?.process;
var Buffer = __bcGlobals()?.shims?.buffer?.Buffer;
var global = globalThis;
var setImmediate = (fn, ...args) => { queueMicrotask(() => fn(...args)); return 0; };
var clearImmediate = () => {};

var __bcFormat = (args) => args.map((a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || String(a);
  if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
  return String(a);
}).join(' ');
var __bcWrite = (stream, args) => __bcGlobals()?.shims?.process?.[stream]?.write(__bcFormat(args) + '\\n');
var console = {
  log: (...args) => __bcWrite('stdout', args),
  info: (...args) => __bcWrite('stdout', args),
  debug: (...args) => __bcWrite('stdout', args),
  table: (...args) => __bcWrite('stdout', args),
  warn: (...args) => __bcWrite('stderr', args),
  error: (...args) => __bcWrite('stderr', args),
  trace: (...args) => __bcWrite('stderr', ['Trace:', ...args]),
  assert: (cond, ...args) => { if (!cond) __bcWrite('stderr', ['Assertion failed' + (args.length ? ':' : ''), ...args]); },
  group: () => {},
  groupEnd: () => {},
};
`.trim();

const vfsPlugin = (vfs: VfsBus): Plugin => ({
  name: "bolo-vfs",
  async resolveId(id, importer) {
    const importerDir = importer ? dirname(importer) : "/";

    if (id.startsWith("#") && importer) {
      const resolved = resolvePackageImportsSubpath(vfs, importer, id);
      if (resolved) return resolved;
    }

    const remap = importer ? applyBrowserFieldRemap(vfs, importer, id) : undefined;
    if (remap === false) return `bolo-empty-stub:${id}`;
    const path = typeof remap === "string" ? remap : id;

    const isRelative = path.startsWith(".") || path.startsWith("/");
    const resolved = isRelative
      ? resolveFile(vfs, path.startsWith("/") ? path : joinPath(importerDir, path))
      : resolveBarePackage(vfs, importerDir, path);

    if (!resolved && isRelative) {
      throw new Error(`Cannot resolve module "${id}" from "${importer || "<entry>"}"`);
    }
    return resolved ?? null;
  },
  async load(id) {
    if (id.startsWith("bolo-empty-stub:")) {
      return { code: "export default {};", map: null };
    }
    // Only handle VFS paths; let other plugins (e.g. node-shim) handle their own virtual schemes.
    if (!id.startsWith("/")) return null;
    const ext = extname(id);
    const contents = vfs.hot.readFileSync(id, "utf8") as string;
    const resolveDir = dirname(id);
    if (ext === ".json") {
      return { code: `export default ${contents};`, map: null, moduleSideEffects: "no-treeshake" };
    }
    // Prepend __dirname/__filename for CJS-style implicit globals
    const prelude = `const __filename=${JSON.stringify(id)};const __dirname=${JSON.stringify(resolveDir)};\n`;
    return { code: prelude + contents, map: null, moduleSideEffects: "no-treeshake" };
  },
});

/**
 * Last-resort resolver: a bare specifier that isn't installed (or whose
 * exports shape this resolver can't yet follow) is marked `external` and
 * rewritten to an esm.sh URL instead of failing the whole bundle — the same
 * CDN fallback `PackageManager` already uses for the install-time import map.
 * Runs after `vfsPlugin`, whose resolveId returns `null` for unresolved bare
 * specifiers so rolldown falls through to this plugin.
 */
const esmShFallbackPlugin = (vfs: VfsBus, warnings: string[]): Plugin => ({
  name: "bolo-esm-sh-fallback",
  async resolveId(id, importer) {
    if (id.startsWith(".") || id.startsWith("/") || id.startsWith("#")) return null;
    if (NODE_BUILTIN_NAMES.has(id)) return null;
    // Already a fully-qualified URL (e.g. package-runner.ts writes
    // `import x from 'https://esm.sh/axios'` directly) — leave it as-is
    // rather than treating "https:" as a bare package name and rebuilding
    // it through buildEsmShUrl, which doubles the esm.sh prefix.
    if (id.startsWith("https://") || id.startsWith("http://")) return { id, external: true };

    const importerDir = importer ? dirname(importer) : "/";
    const isScoped = id.startsWith("@");
    const parts = id.split("/");
    const name = isScoped ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = (isScoped ? parts.slice(2) : parts.slice(1)).join("/");
    const pkgDir = findPackageDir(vfs, importerDir, name);
    const version = pkgDir
      ? (readPackageJson(vfs, pkgDir).version as string | undefined)
      : undefined;
    const url = subpath
      ? `${buildEsmShUrl(name, version)}/${subpath}`
      : buildEsmShUrl(name, version);

    warnings.push(
      `"${id}" could not be resolved off the installed node_modules — falling back to ${url}`,
    );

    return { id: url, external: true };
  },
});

const nodeAliasPlugin = (
  getShim?: (builtin: string) => Record<string, unknown> | undefined,
  warnings?: string[],
): Plugin => ({
  name: "bolo-node-alias",
  async resolveId(id) {
    const builtin = id.startsWith("node:") ? id.slice(5) : id;
    if (!NODE_BUILTIN_NAMES.has(builtin)) return null;

    const shim = getShim?.(builtin);
    if (!shim) {
      warnings?.push(`no browser shim registered for node builtin "node:${builtin}"`);
      return { id, external: true };
    }
    return `bolo-node-shim:${builtin}`;
  },
  async load(id) {
    if (!id.startsWith("bolo-node-shim:")) return null;
    const builtin = id.slice("bolo-node-shim:".length);
    const shim = getShim?.(builtin);
    if (!shim) {
      // Unsupported builtins are left external in resolveId; this branch is defensive.
      return {
        code: `throw new Error("Unsupported node builtin \\"node:${builtin}\\" — no browser shim is registered for it.");`,
        map: null,
      };
    }
    const keys = Object.keys(shim).filter((k) => VALID_JS_IDENTIFIER.test(k));
    const contents = [
      `const __shim = globalThis.__browserContainers.shims[${JSON.stringify(builtin)}];`,
      "export default __shim;",
      ...keys.map((k) => `export const ${k} = __shim[${JSON.stringify(k)}];`),
    ].join("\n");
    return { code: contents, map: null };
  },
});

const jsrAliasPlugin = (): Plugin => ({
  name: "bolo-jsr-alias",
  async resolveId(id, importer) {
    if (!id.startsWith("jsr:")) return null;
    const mapped = mapJsrSpecifier(id);
    // Delegate to rolldown's own resolver
    return this.resolve(mapped, importer, { skipSelf: true });
  },
});

export const bundleEntry = async (
  entry: string,
  options: BundleEntryOptions,
): Promise<BundleEntryResult> => {
  const rolldownMod = await getRolldown();
  const rolldown = rolldownMod.rolldown;

  const warnings: string[] = [];

  const bundle = await rolldown({
    input: entry,
    cwd: options.cwd ?? "/",
    treeshake: false,
    plugins: [
      jsrAliasPlugin(),
      vfsPlugin(options.vfs),
      nodeAliasPlugin(options.getShim, warnings),
      esmShFallbackPlugin(options.vfs, warnings),
    ],
    transform: {
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.browser": "true",
      },
    },
    onLog(level, log, _logger) {
      if (level === "warn") warnings.push(String(log));
    },
  });

  const result = await bundle.generate({
    format: "es",
    banner: GLOBALS_BANNER,
  });

  const chunk = result.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error(`rolldown produced no output for entry "${entry}"`);

  return { code: chunk.code, warnings };
};

export interface TransformScriptOptions {
  /** Defaults to `'ts'` — accepts plain JS too, since that's a subset. */
  readonly loader?: "ts" | "tsx" | "js" | "jsx";
}

export interface TransformScriptResult {
  readonly code: string;
  readonly warnings: string[];
}

/**
 * Single-file TypeScript-to-JS transform (no bundling, no module resolution)
 * via oxc-transform — used by the QuickJS agent sandbox in place of
 * its previous hand-rolled regex type-stripper, which used non-greedy
 * `[\s\S]*?\}` matches that broke on nested object types/interfaces and
 * couldn't handle decorators or multi-line generic constraints correctly.
 */
export const transformScript = async (
  code: string,
  options?: TransformScriptOptions,
): Promise<TransformScriptResult> => {
  const oxc = await getOxc();
  const lang = options?.loader ?? "ts";
  const result = await oxc.transform(`input.${lang}`, code, { sourceType: "module" });
  if (result.errors?.length) {
    throw new Error(result.errors.map((e: any) => e.message).join("\n"));
  }
  return {
    code: result.code,
    warnings: result.errors?.map((e: any) => e.message) ?? [],
  };
};
