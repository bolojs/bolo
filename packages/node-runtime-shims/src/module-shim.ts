import type { VfsBus } from "@bolojs/fs";

// Same list `unenv/node/module` ships (`builtinModules`), kept in sync with
// its https://github.com/unjs/unenv source rather than importing it, since
// the array itself has no browser dependency.
const BUILTIN_MODULE_NAMES = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "stream",
  "string_decoder",
  "timers",
  "timers/promises",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

// Node builtins with no default browser shim, exposed as pluggable extension
// points. `isBuiltin` still recognizes them, and `require` routes them through
// `getShim` first; if no backend is registered, the error message points to
// `createLiveShimRegistry`.
const PLUGGABLE_BUILTIN_NAMES = ["dgram", "net", "tls", "cluster"];

const dirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
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

const stripNodePrefix = (specifier: string): string =>
  specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;

export interface ModuleShimOptions {
  readonly vfs: VfsBus;
  /** Resolves a node builtin name (no `node:` prefix) to its live shim, if any. */
  readonly getShim: (builtin: string) => unknown;
  readonly nativeAddonLoader?: (modulePath: string, vfs: VfsBus) => unknown;
}

/**
 * `node:module`'s `createRequire` is normally used for two things in
 * real-world node apps: pulling in `.json` files, and (rarely) a handful of
 * node builtins outside static `import`. Neither needs esbuild's bundle-time
 * resolution, so both are supported synchronously here. Anything else — a
 * dynamic `require()` of an npm package — can't work post-bundle (esbuild
 * resolution is static and async) and fails with a clear, catalogued error
 * rather than a silent 404, per this codebase's compat-reporting contract.
 */
export const createModuleShim = (options: ModuleShimOptions) => {
  const { vfs, getShim, nativeAddonLoader } = options;

  const createRequire = (filename: string) => {
    const require = (specifier: string): unknown => {
      const bare = stripNodePrefix(specifier);

      if (BUILTIN_MODULE_NAMES.includes(bare) || PLUGGABLE_BUILTIN_NAMES.includes(bare)) {
        const shim = getShim(bare);
        if (shim) return shim;

        if (PLUGGABLE_BUILTIN_NAMES.includes(bare)) {
          throw new Error(
            `require("${specifier}") has no browser implementation built in. ` +
              `Register a custom backend: createLiveShimRegistry({ ${bare}Backend: yourImpl })`,
          );
        }
        throw new Error(
          `require("${specifier}") has no browser shim registered for node builtin "${bare}".`,
        );
      }

      // Native addon (.node)
      if (specifier.endsWith(".node") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        if (!nativeAddonLoader) {
          throw new Error(
            `require("${specifier}") is a native addon. Pass nativeAddonLoader to ` +
              `createLiveShimRegistry to handle .node imports.`,
          );
        }
        const resolved = specifier.startsWith("/")
          ? specifier
          : joinPath(dirname(filename), specifier);
        return nativeAddonLoader(resolved, vfs);
      }

      if (specifier.endsWith(".json") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        const resolved = specifier.startsWith("/")
          ? specifier
          : joinPath(dirname(filename), specifier);
        if (!vfs.hot.existsSync(resolved)) {
          throw new Error(`require("${specifier}") could not find JSON file "${resolved}".`);
        }
        return JSON.parse(vfs.hot.readFileSync(resolved, "utf8") as string);
      }

      throw new Error(
        `require("${specifier}") is not supported: dynamic require() of npm packages is not available in ` +
          "the browser runtime after bundling. Use a static `import` instead.",
      );
    };

    require.resolve = Object.assign(
      (specifier: string): string => {
        const bare = stripNodePrefix(specifier);
        if (BUILTIN_MODULE_NAMES.includes(bare)) return `node:${bare}`;
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
          return specifier.startsWith("/") ? specifier : joinPath(dirname(filename), specifier);
        }
        throw new Error(
          `require.resolve("${specifier}") is not supported for npm packages post-bundle.`,
        );
      },
      { paths: (_request: string): string[] | null => null },
    );
    require.cache = Object.create(null) as Record<string, unknown>;
    require.main = undefined;
    require.extensions = {} as Record<string, unknown>;

    return require;
  };

  const isBuiltin = (id: string): boolean =>
    id.startsWith("node:") ||
    BUILTIN_MODULE_NAMES.includes(id) ||
    PLUGGABLE_BUILTIN_NAMES.includes(id);

  /**
   * `node:module.findPackageJSON(specifier[, base])` — Node ≥22. Resolution
   * of bare specifiers is not available post-bundle (same limit as
   * `require()` above), so only `./`/`../`/`/` specifiers are followed: the
   * target path is located, then its nearest ancestor `package.json` is
   * returned. `undefined` means "not found", matching Node's contract.
   */
  const findPackageJSON = (specifier: string, base?: string | URL): string | undefined => {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
    const basePath =
      base === undefined
        ? "/"
        : base instanceof URL
          ? base.pathname
          : base.startsWith("file://")
            ? new URL(base).pathname
            : base;
    const startDir = specifier.startsWith("/")
      ? dirname(specifier)
      : dirname(joinPath(dirname(basePath), specifier));
    let dir = startDir;
    for (;;) {
      const candidate = joinPath(dir, "package.json");
      if (vfs.hot.existsSync(candidate)) return candidate;
      if (dir === "/") return undefined;
      dir = dirname(dir);
    }
  };

  /**
   * The `Module` constructor itself — vite and other toolchain packages do
   * `import { Module } from "node:module"` for `Module._nodeModulePaths` /
   * `Module.createRequire` / `Module.builtinModules`. Instance state is a
   * plain record; the statics mirror Node's surface. `syncBuiltinESMExports`
   * is a no-op (our builtin shims are not a mutable require-cache), and
   * `register` accepts arguments but cannot spawn a module-customization
   * thread in the browser — it is a documented no-op.
   */
  const Module = function Module(this: Record<string, unknown>, id = "", parent?: unknown): void {
    this.id = id;
    this.path = dirname(id);
    this.exports = {};
    this.parent = parent;
    this.filename = null;
    this.loaded = false;
    this.children = [];
    this.paths = [];
  } as unknown as {
    new (id?: string, parent?: unknown): Record<string, unknown>;
    _cache: Record<string, unknown>;
    _pathCache: Record<string, unknown>;
    _extensions: Record<string, unknown>;
    _preloadModules: unknown[];
    wrapper: string[];
    globalPaths: string[];
    builtinModules: string[];
    createRequire: typeof createRequire;
    findPackageJSON: typeof findPackageJSON;
    isBuiltin: typeof isBuiltin;
    _nodeModulePaths: (from: string) => string[];
    syncBuiltinESMExports: () => void;
    register: (...args: unknown[]) => void;
    flushCompileCache: () => void;
    getCompileCacheDir: () => undefined;
    enableCompileCache: () => undefined;
    wrap: (script: string) => string;
    _compile: () => void;
    runMain: () => void;
    _initPaths: () => void;
    _resolveFilename: (request: string) => string;
    _load: () => void;
    _resolveLookupPaths: () => null;
    _findPath: () => false;
    stripTypeScriptTypes: (code: string) => string;
    constants: Record<string, unknown>;
  };

  Module._cache = Object.create(null);
  Module._pathCache = Object.create(null);
  Module._extensions = Object.create(null);
  Module._preloadModules = [];
  Module.wrapper = ["(function (exports, require, module, __filename, __dirname) {", "\n})"];
  Module.globalPaths = [];
  Module.builtinModules = BUILTIN_MODULE_NAMES;
  Module.createRequire = createRequire;
  Module.findPackageJSON = findPackageJSON;
  Module.isBuiltin = isBuiltin;
  Module._nodeModulePaths = (from: string): string[] => {
    const paths: string[] = [];
    let dir = joinPath("/", from);
    for (;;) {
      if (dir !== "/") paths.push(joinPath(dir, "node_modules"));
      if (dir === "/") {
        paths.push("/node_modules");
        return paths;
      }
      dir = dirname(dir);
    }
  };
  Module.syncBuiltinESMExports = () => {};
  Module.register = () => {};
  Module.flushCompileCache = () => {};
  Module.getCompileCacheDir = () => undefined;
  Module.enableCompileCache = () => undefined;
  Module.wrap = (script: string): string => `${Module.wrapper[0]}${script}${Module.wrapper[1]}`;
  Module._compile = () => {};
  Module.runMain = () => {};
  Module._initPaths = () => {};
  Module._resolveFilename = (request: string): string => request;
  Module._load = () => {};
  Module._resolveLookupPaths = () => null;
  Module._findPath = () => false;
  Module.stripTypeScriptTypes = (code: string): string => code;
  Module.constants = Object.create(null);

  return {
    createRequire,
    builtinModules: BUILTIN_MODULE_NAMES,
    isBuiltin,
    findPackageJSON,
    Module,
  };
};

export type ModuleShim = ReturnType<typeof createModuleShim>;
