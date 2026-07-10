import type { VfsBus } from "@browser-containers/vfs-bus";
import type { Plugin } from "esbuild-wasm";
import { buildEsmShUrl } from "@browser-containers/npm";
import { initEsbuild } from "./index.js";

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const LOADER_BY_EXT: Record<string, "ts" | "tsx" | "js" | "jsx" | "json"> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
};

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

const resolveFile = (vfs: VfsBus, base: string): string | undefined => {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (ext === "") continue;
    const candidate = joinPath(base, "index" + ext);
    if (vfs.hot.existsSync(candidate) && isFile(vfs, candidate)) return candidate;
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

const EMPTY_STUB_NAMESPACE = "browser-containers-empty-stub";

const vfsPlugin = (vfs: VfsBus): Plugin => ({
  name: "browser-containers-vfs",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const importerDir = args.importer ? dirname(args.importer) : args.resolveDir || "/";

      // Package-internal `#subpath` imports (the `imports` field) always
      // resolve against the *importing* file's own package, never a
      // `node_modules` lookup — handle before the bare-specifier branch below.
      if (args.path.startsWith("#") && args.importer) {
        const resolved = resolvePackageImportsSubpath(vfs, args.importer, args.path);
        if (resolved) return { path: resolved, namespace: "browser-containers-vfs" };
        return {
          errors: [
            { text: `Cannot resolve package import "${args.path}" from "${args.importer}"` },
          ],
        };
      }

      // The `browser` field remap applies to every specifier (relative or
      // bare) written inside a package's own files, per the browserify/
      // webpack convention — check it before normal resolution.
      const remap = args.importer
        ? applyBrowserFieldRemap(vfs, args.importer, args.path)
        : undefined;
      if (remap === false) return { path: args.path, namespace: EMPTY_STUB_NAMESPACE };
      const path = typeof remap === "string" ? remap : args.path;

      const isRelative = path.startsWith(".") || path.startsWith("/");
      const resolved = isRelative
        ? resolveFile(vfs, path.startsWith("/") ? path : joinPath(importerDir, path))
        : resolveBarePackage(vfs, importerDir, path);

      if (!resolved) {
        // Relative-path failures are almost always a real typo in the app's
        // own code — fail loudly. Bare specifiers fall through to the
        // esm.sh fallback plugin (registered after this one) instead of
        // failing the whole bundle, since they might be an uninstalled
        // transitive dep or an export shape this resolver doesn't cover yet.
        if (isRelative) {
          return {
            errors: [
              { text: `Cannot resolve module "${args.path}" from "${args.importer || "<entry>"}"` },
            ],
          };
        }
        return undefined;
      }
      return { path: resolved, namespace: "browser-containers-vfs" };
    });

    build.onLoad({ filter: /.*/, namespace: "browser-containers-vfs" }, (args) => {
      const contents = vfs.hot.readFileSync(args.path, "utf8") as string;
      const loader = LOADER_BY_EXT[extname(args.path)] ?? "js";
      const resolveDir = dirname(args.path);
      // CJS-style implicit globals — esbuild only auto-defines these for
      // `format: 'cjs'` output; our bundle is ESM, so each module gets its
      // own `__dirname`/`__filename` consts prepended (harmless before
      // `import`/`export` declarations, which are hoisted regardless of
      // source position).
      if (loader === "json") return { contents, loader, resolveDir };
      const prelude = `const __filename=${JSON.stringify(args.path)};const __dirname=${JSON.stringify(resolveDir)};\n`;
      return { contents: prelude + contents, loader, resolveDir };
    });

    build.onLoad({ filter: /.*/, namespace: EMPTY_STUB_NAMESPACE }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
});

/**
 * Last-resort resolver: a bare specifier that isn't installed (or whose
 * exports shape this resolver can't yet follow) is marked `external` and
 * rewritten to an esm.sh URL instead of failing the whole bundle — the same
 * CDN fallback `PackageManager` already uses for the install-time import map.
 * Runs after `vfsPlugin`, whose onResolve returns `undefined` (not an error)
 * for unresolved bare specifiers so esbuild falls through to this plugin.
 */
const esmShFallbackPlugin = (vfs: VfsBus): Plugin => ({
  name: "browser-containers-esm-sh-fallback",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith(".") || args.path.startsWith("/") || args.path.startsWith("#"))
        return undefined;
      if (NODE_BUILTIN_NAMES.has(args.path)) return undefined;

      const importerDir = args.importer ? dirname(args.importer) : args.resolveDir || "/";
      const isScoped = args.path.startsWith("@");
      const parts = args.path.split("/");
      const name = isScoped ? parts.slice(0, 2).join("/") : parts[0];
      const subpath = (isScoped ? parts.slice(2) : parts.slice(1)).join("/");
      const pkgDir = findPackageDir(vfs, importerDir, name);
      const version = pkgDir
        ? (readPackageJson(vfs, pkgDir).version as string | undefined)
        : undefined;
      const url = subpath
        ? `${buildEsmShUrl(name, version)}/${subpath}`
        : buildEsmShUrl(name, version);

      return {
        path: url,
        external: true,
        warnings: [
          {
            text: `"${args.path}" could not be resolved off the installed node_modules — falling back to ${url}`,
          },
        ],
      };
    });
  },
});

// Injected into every module via esbuild's `inject` so bare references to
// `process`/`Buffer`/`global`/`setImmediate` (never explicitly imported —
// the overwhelming majority of CJS/npm code assumes they're ambient) resolve
// without every package needing an explicit `require('node:process')`.
// Reads `globalThis.__browserContainers` at module-eval time, which
// `ShellService.runNodeApp` populates just before importing the bundle.
const GLOBALS_PRELUDE_PATH = "browser-containers-globals-prelude";
const GLOBALS_PRELUDE_NAMESPACE = "browser-containers-globals-prelude";
const GLOBALS_PRELUDE_SOURCE = `
const __bcGlobals = () => globalThis.__browserContainers;
export const process = __bcGlobals()?.shims?.process;
export const Buffer = __bcGlobals()?.shims?.buffer?.Buffer;
export const global = globalThis;
export const setImmediate = (fn, ...args) => { queueMicrotask(() => fn(...args)); return 0; };
export const clearImmediate = () => {};

// esbuild's \`inject\` rewrites every bare, unshadowed reference to these export
// names within the bundle scope — including \`console\`, even though it also
// resolves to a real browser global. Left unhandled, bundled \`console.log\`
// calls silently reach devtools instead of this container's captured
// stdout/stderr (the terminal UI and any harness reading process output would
// see nothing), unlike real Node where the global Console is constructed from
// \`process.stdout\`/\`process.stderr\` in the first place.
const __bcFormat = (args) => args.map((a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || String(a);
  if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
  return String(a);
}).join(' ');
const __bcWrite = (stream, args) => __bcGlobals()?.shims?.process?.[stream]?.write(__bcFormat(args) + '\\n');
export const console = {
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
`;

const globalsPreludePlugin = (): Plugin => ({
  name: "browser-containers-globals-prelude",
  setup(build) {
    build.onResolve({ filter: new RegExp(`^${GLOBALS_PRELUDE_PATH}$`) }, (args) => ({
      path: args.path,
      namespace: GLOBALS_PRELUDE_NAMESPACE,
    }));
    build.onLoad({ filter: /.*/, namespace: GLOBALS_PRELUDE_NAMESPACE }, () => ({
      contents: GLOBALS_PRELUDE_SOURCE,
      loader: "js",
    }));
  },
});

const nodeAliasPlugin = (
  getShim?: (builtin: string) => Record<string, unknown> | undefined,
): Plugin => ({
  name: "browser-containers-node-alias",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path.slice("node:".length),
      namespace: "browser-containers-node-shim",
    }));

    build.onResolve({ filter: /.*/ }, (args) => {
      if (!NODE_BUILTIN_NAMES.has(args.path)) return undefined;
      return { path: args.path, namespace: "browser-containers-node-shim" };
    });

    build.onLoad({ filter: /.*/, namespace: "browser-containers-node-shim" }, (args) => {
      const shim = getShim?.(args.path);
      if (!shim) {
        return {
          contents: `throw new Error(${JSON.stringify(
            `Unsupported node builtin "node:${args.path}" — no browser shim is registered for it.`,
          )});`,
          loader: "js",
          warnings: [{ text: `no browser shim registered for node builtin "node:${args.path}"` }],
        };
      }
      const keys = Object.keys(shim).filter((k) => VALID_JS_IDENTIFIER.test(k));
      const contents = [
        `const __shim = globalThis.__browserContainers.shims[${JSON.stringify(args.path)}];`,
        "export default __shim;",
        ...keys.map((k) => `export const ${k} = __shim[${JSON.stringify(k)}];`),
      ].join("\n");
      return { contents, loader: "js" };
    });
  },
});

const jsrAliasPlugin = (): Plugin => ({
  name: "browser-containers-jsr-alias",
  setup(build) {
    build.onResolve({ filter: /^jsr:/ }, async (args) => {
      const mapped = mapJsrSpecifier(args.path);
      return await build.resolve(mapped, {
        importer: args.importer,
        namespace: args.namespace,
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
    });
  },
});

export const bundleEntry = async (
  entry: string,
  options: BundleEntryOptions,
): Promise<BundleEntryResult> => {
  const esbuild = await initEsbuild();
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    absWorkingDir: options.cwd ?? "/",
    // jsrAliasPlugin runs first so `jsr:` specifiers are rewritten to the
    // npm-compatibility mirror name before vfsPlugin looks them up in
    // node_modules. vfsPlugin runs before nodeAliasPlugin so a package's own
    // `browser` field remap (e.g. `"fs": false`) can win over our builtin
    // shim for that package's imports — vfsPlugin declines (returns undefined,
    // not an error) on unresolved bare specifiers, so normal builtin names like
    // plain `fs` still fall through to nodeAliasPlugin as before.
    plugins: [
      globalsPreludePlugin(),
      jsrAliasPlugin(),
      vfsPlugin(options.vfs),
      nodeAliasPlugin(options.getShim),
      esmShFallbackPlugin(options.vfs),
    ],
    inject: [GLOBALS_PRELUDE_PATH],
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "process.browser": "true",
    },
    logLevel: "silent",
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild produced no output for entry "${entry}"`);
  }

  return { code: outputFile.text, warnings: result.warnings.map((w) => w.text) };
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
 * via esbuild's real parser — used by the QuickJS agent sandbox in place of
 * its previous hand-rolled regex type-stripper, which used non-greedy
 * `[\s\S]*?\}` matches that broke on nested object types/interfaces and
 * couldn't handle decorators or multi-line generic constraints correctly.
 */
export const transformScript = async (
  code: string,
  options?: TransformScriptOptions,
): Promise<TransformScriptResult> => {
  const esbuild = await initEsbuild();
  const result = await esbuild.transform(code, { loader: options?.loader ?? "ts" });
  return { code: result.code, warnings: result.warnings.map((w) => w.text) };
};
