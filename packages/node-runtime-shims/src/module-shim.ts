import type { VfsBus } from "@bolojs/fs";
import { unsupportedError } from "@bolojs/node-web-shims";

// Same list `unenv/node/module` ships (`builtinModules`), kept in sync with
// its https://github.com/unjs/unenv source rather than importing it, since
// the array itself has no browser dependency.
const BUILTIN_MODULE_NAMES = [
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "console",
  "constants",
  "crypto",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
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
  "domain",
  "repl",
  "inspector",
  "trace_events",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tty",
  "url",
  "util",
  "util/types",
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
 * Node's default CJS wrapper. `Module.wrapper` starts as this exact pair and
 * stays mutable: code may prepend to `wrapper[0]` or replace the array
 * wholesale, and every module compiled afterwards must pick the change up
 * (Node compiles each CJS file with `Module.wrap(source)` at require time).
 */
const DEFAULT_WRAPPER: readonly string[] = [
  "(function (exports, require, module, __filename, __dirname) {",
  "\n})",
];

/** Extensions a relative require can resolve to a CommonJS source file. */
const CJS_EXTENSIONS = [".js", ".cjs"];

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

  /**
   * Node's `require.cache` is per-`Module` graph, but the browser runtime has
   * one module registry per container; keying by absolute path gives Node's
   * "same file required twice is the same module" semantics.
   */
  const moduleCache = new Map<string, { exports: unknown }>();

  /**
   * Resolves a relative/absolute specifier to a CommonJS source file in the
   * VFS. Node's resolution tries the exact path first, then the extension
   * list (`.js`, `.json`, `.node`), then `<dir>/index.js`.
   */
  const resolveCjsFile = (base: string): string | undefined => {
    const candidates = [base, ...CJS_EXTENSIONS.map((ext) => base + ext)];
    for (const candidate of candidates) {
      if (candidate.endsWith(".json")) continue;
      if (vfs.hot.existsSync(candidate)) return candidate;
    }
    for (const candidate of candidates) {
      if (!candidate.endsWith("/") && vfs.hot.existsSync(candidate)) return candidate;
    }
    for (const ext of CJS_EXTENSIONS) {
      const index = joinPath(base, `index${ext}`);
      if (vfs.hot.existsSync(index)) return index;
    }
    return undefined;
  };

  /**
   * Compiles a CommonJS file the way Node does: the source is wrapped with
   * the *live* `Module.wrapper` (so a program that mutated it before the
   * require sees its own prefix — `test-module-wrap`), the wrapper expression
   * is evaluated to the module function and invoked with this file's
   * `require`/`module`/`__filename`/`__dirname`, and the exports are cached
   * by path so a second require returns the same object.
   */
  const compileCjsModule = (path: string): unknown => {
    const cached = moduleCache.get(path);
    if (cached) return cached.exports;
    const source = vfs.hot.readFileSync(path, "utf8") as string;
    const module = { id: path, filename: path, exports: {} as unknown, loaded: false };
    moduleCache.set(path, module);
    const require = createRequire(path);
    const wrapperSource = Module.wrapper[0] + source + Module.wrapper[1];
    let fn: (
      exports: unknown,
      require: (specifier: string) => unknown,
      module: { exports: unknown },
      filename: string,
      dirname: string,
    ) => void;
    try {
      // Node evaluates `Module.wrap(source)` as an *expression* whose value is
      // the wrapper function (vm.runInThisContext). `new Function` takes a
      // statement body, so the function expression must be returned, not
      // declared — otherwise the body never runs and the wrapper prefix is
      // silently skipped.
      fn = new Function(`return ${wrapperSource}`)() as typeof fn;
    } catch (err) {
      moduleCache.delete(path);
      throw err;
    }
    fn.call(module.exports, module.exports, require, module, path, dirname(path));
    module.loaded = true;
    return module.exports;
  };

  const createRequire = (filename: string) => {
    const require = (specifier: string): unknown => {
      const bare = stripNodePrefix(specifier);

      if (BUILTIN_MODULE_NAMES.includes(bare) || PLUGGABLE_BUILTIN_NAMES.includes(bare)) {
        // Subpath builtins resolve like the bundler's nodeAliasPlugin: a
        // registry key of their own first ("timers/promises"), then the
        // variant property on the parent shim ("fs/promises" → fs.promises,
        // "path/win32" → path.win32), then — for dns/promises — the parent
        // itself, since our dns shim's methods all return promises already.
        let shim = getShim(bare);
        if (shim === undefined) {
          const slash = bare.indexOf("/");
          if (slash !== -1) {
            const parent = getShim(bare.slice(0, slash)) as Record<string, unknown> | undefined;
            const sub = bare.slice(slash + 1);
            shim = parent?.[sub] ?? (bare === "dns/promises" ? parent : undefined);
          }
        }
        if (shim !== undefined) return shim;

        if (PLUGGABLE_BUILTIN_NAMES.includes(bare)) {
          throw unsupportedError(
            `${bare.toUpperCase()}_BACKEND`,
            `require("${specifier}") has no browser implementation built in. ` +
              `Register a custom backend: createLiveShimRegistry({ ${bare}Backend: yourImpl })`,
          );
        }
        throw unsupportedError(
          "NODE_BUILTIN",
          `require("${specifier}") has no browser shim registered for node builtin "${bare}".`,
        );
      }

      // Native addon (.node)
      if (specifier.endsWith(".node") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        if (!nativeAddonLoader) {
          throw unsupportedError(
            "NATIVE_ADDON_LOADER",
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

      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = resolveCjsFile(
          specifier.startsWith("/") ? specifier : joinPath(dirname(filename), specifier),
        );
        if (resolved !== undefined) return compileCjsModule(resolved);
        throw new Error(`Cannot find module "${specifier}" (resolved from "${filename}")`);
      }

      throw unsupportedError(
        "DYNAMIC_REQUIRE",
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
        throw unsupportedError(
          "REQUIRE_RESOLVE",
          `require.resolve("${specifier}") is not supported for npm packages post-bundle.`,
        );
      },
      { paths: (_request: string): string[] | null => null },
    );
    // Node's `require.cache` is keyed by resolved filename; the runtime CJS
    // loader shares one registry per container, so a `delete
    // require.cache[require.resolve(...)]` drops the entry and the next
    // require re-executes the file (test-module-wrapper).
    require.cache = moduleCache as unknown as Record<string, unknown>;
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
  Module.wrapper = [...DEFAULT_WRAPPER];
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

  const shim = {
    createRequire,
    builtinModules: BUILTIN_MODULE_NAMES,
    isBuiltin,
    findPackageJSON,
    Module,
    /**
     * Compiles a CommonJS file from the VFS with the live `Module.wrapper`.
     * The bundler calls this when a program customized the wrapper before
     * requiring the file (Node compiles every CJS module with
     * `Module.wrap(source)` at require time).
     */
    __compileCjs: compileCjsModule,
    /**
     * True while `Module.wrapper` still is Node's default pair — the
     * bundler uses it to decide between the statically bundled module body
     * and a runtime compile with the program's own wrapper.
     */
    __isDefaultWrapper: (): boolean =>
      Module.wrapper.length === DEFAULT_WRAPPER.length &&
      Module.wrapper.every((part, i) => part === DEFAULT_WRAPPER[i]),
  };

  // Node's `require('module')` IS the Module constructor, so `m.wrapper` and
  // `Module.wrapper` are the same property: mutating the array in place and
  // replacing it wholesale both change what every later require compiles
  // with. The accessor keeps that aliasing without handing out the whole
  // constructor as the module namespace.
  Object.defineProperty(shim, "wrapper", {
    get: () => Module.wrapper,
    set: (value: string[]) => {
      Module.wrapper = value;
    },
    enumerable: true,
    configurable: true,
  });

  return shim;
};

export type ModuleShim = ReturnType<typeof createModuleShim>;
