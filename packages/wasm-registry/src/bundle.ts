import type { VfsBus } from "@bolojs/fs";
import type { Plugin } from "@rolldown/browser";
import { buildEsmShUrl } from "@bolojs/pm";

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

/**
 * Drops the cached rolldown/oxc module promises so the next `bundleEntry` /
 * `transformScript` re-enters the lazy-load path. Recovery for a wedged
 * bundler: `@napi-rs/wasm-runtime` can throw `Atomics.wait cannot be called
 * in this context` inside the WASM glue, which leaves the in-flight
 * `rolldown()` promise unsettled forever. A caller-side deadline abandons
 * the hung call; clearing the cache then lets the next call re-import the
 * module (CDN path) or re-drive its lazy init instead of reusing the
 * poisoned instance.
 */
export const resetBundler = (): void => {
  _rolldown = undefined;
  _oxc = undefined;
};

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

// Builtins with a browser shim available somewhere in the host realm (either
// stateless, from `node-web-shims`, or host-bound, from `node-runtime-shims`).
// Resolution of the *live* value happens via `getShim` at bundle time — this
// package only knows the builtin's name, not its implementation.
export const NODE_BUILTIN_NAMES = new Set([
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "child_process",
  "path",
  "path/posix",
  "path/win32",
  "buffer",
  "url",
  "crypto",
  "os",
  "events",
  "stream",
  "stream/promises",
  "stream/web",
  "stream/consumers",
  "util",
  "util/types",
  "async_hooks",
  "querystring",
  "worker_threads",
  "string_decoder",
  "tty",
  "assert",
  "assert/strict",
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
  "readline/promises",
  "domain",
  "tls",
  "dgram",
  "cluster",
  "repl",
  "inspector",
  "trace_events",
  "vm",
  "dns",
  "dns/promises",
  "console",
  "v8",
  "http2",
]);

// Subpath builtins that have no dedicated shim object because the parent
// already IS the requested variant — our `dns` shim's methods all return
// promises, so `node:dns/promises` is the `dns` object itself.
const SUBPATH_SELF_ALIASES: Record<string, string> = {
  "dns/promises": "dns",
};

// Export names of the `console` object GLOBALS_BANNER injects — kept in sync
// with the banner literal below so `import console from "node:console"`
// resolves to the same stdout/stderr-routed surface.
const BANNER_CONSOLE_KEYS = [
  "log",
  "info",
  "debug",
  "table",
  "dir",
  "dirxml",
  "warn",
  "error",
  "trace",
  "assert",
  "clear",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
  "group",
  "groupCollapsed",
  "groupEnd",
  "Console",
];

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

// Condition priority for `exports`/`imports` resolution. The bundle executes
// in the runtime's process-worker realm, which has no DOM — so `worker`
// (which dual packages use to serve their DOM-free build, e.g.
// decode-named-character-reference's pure-JS decoder) wins over `browser`
// (whose builds may touch `document` at module scope), then `import`/`module`,
// then `default` — `require`/`node` are never picked since we never want the
// CJS or server-only branch of a dual package.
const CONDITIONS = ["worker", "browser", "import", "module", "default"];

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

  // `browser` map keys are either bare specifiers ("fs", "graceful-fs") or
  // package-root-relative paths ("./lib/util/process-browser.js"). A relative
  // require must therefore be expressed as a `./`-key relative to the
  // PACKAGE ROOT — not to the importer — before lookup, and with the usual
  // extension guesses since keys are written with the extension on.
  const candidates: string[] = specifier.startsWith(".")
    ? (() => {
        const abs = joinPath(dirname(importerFile), specifier);
        if (!abs.startsWith(`${owningDir}/`)) return [specifier];
        const rel = `.${abs.slice(owningDir.length)}`;
        return [
          rel,
          ...RESOLVE_EXTENSIONS.filter((e) => e).map((e) => rel + e),
          `${rel}/index.js`,
          specifier,
        ];
      })()
    : [specifier];
  for (const candidate of candidates) {
    if (candidate in map) {
      const value = map[candidate];
      if (value === false) return false;
      if (typeof value !== "string") return undefined;
      // A relative replacement is rooted at the package directory, not the
      // importer — resolve it eagerly to an absolute path so the caller's
      // `isRelative` handling lands on the right file. This is what
      // enhanced-resolve's `"process": "./lib/util/process-browser.js"`
      // (a browser-field remap of a NODE BUILTIN) needs.
      return value.startsWith(".") ? joinPath(owningDir, value) : value;
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

const TIMER_GLOBALS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
] as const;

// Injected globals are bound to `__bc_*` names, never to the well-known
// identifier itself: the banner is prepended AFTER bundling, so a `var
// Buffer`/`var process` here would be a parse-time redeclare error against
// any bundled module whose top-level `const`/`function`/`class`/`import`
// binding rolldown hoisted into the shared chunk scope (the probe's
// `Uncaught SyntaxError: Identifier 'Buffer' has already been declared`).
// Free references in user code reach these bindings through
// `transform.define` rewrites instead — same mechanism as the timer
// globals below — which only rewrites UNBOUND references, so a module that
// declares its own `Buffer`/`process`/`console` keeps it untouched.
const GLOBALS_BANNER = `
var __bcGlobals = () => globalThis.__browserContainers;
var __bc_process = __bcGlobals()?.shims?.process;
var __bc_Buffer = __bcGlobals()?.shims?.buffer?.Buffer;
var __bc_global = globalThis;
// Process workers inject handle-tracked timers so only the *program's*
// timers keep the process alive — infrastructure (logging, rpc) uses real
// globals and is invisible to liveness. Main-thread path: real globals.
var __bcTimers = __bcGlobals()?.timers;
var __bc_setTimeout = __bcTimers?.setTimeout ?? globalThis.setTimeout;
var __bc_clearTimeout = __bcTimers?.clearTimeout ?? globalThis.clearTimeout;
var __bc_setInterval = __bcTimers?.setInterval ?? globalThis.setInterval;
var __bc_clearInterval = __bcTimers?.clearInterval ?? globalThis.clearInterval;
// Process workers own a Node-style loop (check phase, ref-counted handles);
// elsewhere fall back to a plain macrotask hop.
var __bc_setImmediate = __bcTimers?.setImmediate ?? ((fn, ...args) => {
  const imm = { cancelled: false, ref() { return imm; }, unref() { return imm; }, hasRef() { return true; } };
  globalThis.setTimeout(() => { if (!imm.cancelled) { fn(...args); __bc_process?.drainTicks?.(); } }, 0);
  return imm;
});
var __bc_clearImmediate = __bcTimers?.clearImmediate ?? ((imm) => { if (imm) imm.cancelled = true; });

var __bcFormat = (args) => args.map((a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || String(a);
  if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
  return String(a);
}).join(' ');
var __bcWrite = (stream, args) => __bcGlobals()?.shims?.process?.[stream]?.write(__bcFormat(args) + '\\n');
// Minimal node:console.Console — stdout/stderr args are accepted (a real
// Writable, or anything with .write) so new Console(stream) mirrors Node;
// the no-arg default routes through the process shim like global console.
var __bc_Console = class {
  constructor(stdout, stderr) {
    this._stdout = stdout;
    this._stderr = stderr ?? stdout;
    this._counts = Object.create(null);
    this._times = Object.create(null);
    this._indent = 0;
  }
  _write(stream, args) {
    var sink = stream === 'stderr' ? this._stderr : this._stdout;
    var line = '  '.repeat(this._indent) + __bcFormat(args);
    if (sink && typeof sink.write === 'function') sink.write(line + '\\n');
    else __bcGlobals()?.shims?.process?.[stream]?.write(line + '\\n');
  }
  log(...args) { this._write('stdout', args); }
  info(...args) { this._write('stdout', args); }
  debug(...args) { this._write('stdout', args); }
  table(...args) { this._write('stdout', args); }
  dir(obj) { this._write('stdout', [obj]); }
  dirxml(obj) { this._write('stdout', [obj]); }
  warn(...args) { this._write('stderr', args); }
  error(...args) { this._write('stderr', args); }
  trace(...args) { this._write('stderr', ['Trace:', ...args]); }
  assert(cond, ...args) { if (!cond) this._write('stderr', ['Assertion failed' + (args.length ? ':' : ''), ...args]); }
  // Node's Console.prototype.clear writes the ANSI clear-screen sequence to
  // stdout with no trailing newline (test-console-clear expects exactly
  // '\x1b[1;1H\x1b[0J').
  clear() {
    var seq = '\\x1b[1;1H\\x1b[0J';
    var sink = this._stdout;
    if (sink && typeof sink.write === 'function') sink.write(seq);
    else __bcGlobals()?.shims?.process?.stdout?.write(seq);
  }
  count(label = 'default') {
    // Implicit string coercion throws TypeError for Symbol labels, matching
    // node:console (test-console-count).
    label = '' + label;
    var n = (this._counts[label] = (this._counts[label] ?? 0) + 1);
    this._write('stdout', [label + ': ' + n]);
  }
  countReset(label = 'default') { label = '' + label; delete this._counts[label]; }
  time(label = 'default') { this._times[label] = globalThis.performance?.now?.() ?? Date.now(); }
  timeEnd(label = 'default') {
    var start = this._times[label];
    if (start === undefined) { this._write('stderr', ['Warning: No such label \\'' + label + '\\' for console.timeEnd()']); return; }
    delete this._times[label];
    var ms = (globalThis.performance?.now?.() ?? Date.now()) - start;
    this._write('stdout', [label + ': ' + ms.toFixed(3) + 'ms']);
  }
  timeLog(label = 'default', ...args) {
    var start = this._times[label];
    if (start === undefined) { this._write('stderr', ['Warning: No such label \\'' + label + '\\' for console.timeLog()']); return; }
    var ms = (globalThis.performance?.now?.() ?? Date.now()) - start;
    this._write('stdout', [label + ': ' + ms.toFixed(3) + 'ms', ...args]);
  }
  group(...args) { if (args.length) this._write('stdout', args); this._indent++; }
  groupCollapsed(...args) { this.group(...args); }
  groupEnd() { if (this._indent > 0) this._indent--; }
};
var __bc_console = new __bc_Console();
__bc_console.Console = __bc_Console;
`.trim();

// Emits a `const <name>=<literal>;` prelude declaration for a CJS implicit
// global only when the module actually references it and doesn't declare its
// own — unconditional injection collides with dist files that compute the
// binding themselves (jest does `const __dirname = dirname(fileURLToPath(
// import.meta.url))`, and a second `const` in the same module scope is a
// parse-time redeclare error).
const implicitGlobalDecl = (name: string, literal: string, contents: string): string => {
  const declared =
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(contents) ||
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}\\n]*\\b${name}\\b`).test(contents) ||
    new RegExp(`\\bimport\\b[^;\\n]*\\b${name}\\b`).test(contents);
  if (declared || !new RegExp(`\\b${name}\\b`).test(contents)) return "";
  return `const ${name}=${literal};`;
};

// Virtual-id prefix for ESM modules that have named exports but no
// `export default` — see load() below.
const NS_DEFAULT_PREFIX = "bolo-ns-default:";

// `export default`, `export {x as default}`, and `export {default} from` all
// provide a default export; `export *` never does.
const HAS_DEFAULT_EXPORT = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/;
const LOOKS_ESM = /^\s*(?:import|export)\s/m;

// Bundler convention (vite/webpack/esm.sh): `import x from "pkg"` on a module
// with only named exports yields the namespace object, matching what Node's
// CJS interop does for require()-shaped packages. Without it, `import yaml
// from "js-yaml"` is a build-time MISSING_EXPORT (js-yaml's .mjs, h3, mkdirp,
// sass all ship named-only entries). Only applied to real ESM — a CJS file
// already gets `default = module.exports` from rolldown's commonjs wrapper.
const maybeWrapNamespaceDefault = (vfs: VfsBus, file: string): string => {
  const ext = extname(file);
  if (ext === ".json" || ext === ".cjs") return file;
  const contents = vfs.hot.readFileSync(file, "utf8") as string;
  if (!LOOKS_ESM.test(contents) || HAS_DEFAULT_EXPORT.test(contents)) return file;
  return `${NS_DEFAULT_PREFIX}${file}`;
};

const vfsPlugin = (vfs: VfsBus, warnings?: string[]): Plugin => ({
  name: "bolo-vfs",
  async resolveId(id, importer) {
    const importerDir = importer ? dirname(importer) : "/";

    // Wrap resolved ESM files that lack a default export — except files
    // imported *by* a wrapper itself, whose target must stay the raw module
    // or the wrapper would import itself in a cycle.
    const finish = (resolved: string | undefined | null) =>
      resolved && importer && resolved.startsWith("/") && !importer.startsWith(NS_DEFAULT_PREFIX)
        ? maybeWrapNamespaceDefault(vfs, resolved)
        : (resolved ?? null);

    if (id.startsWith("#") && importer) {
      const resolved = resolvePackageImportsSubpath(vfs, importer, id);
      if (resolved) return finish(resolved);
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
    return finish(resolved);
  },
  async load(id) {
    if (id.startsWith("bolo-empty-stub:")) {
      return { code: "export default {};", map: null };
    }
    if (id.startsWith(NS_DEFAULT_PREFIX)) {
      // `export *` never re-exports a default, so the synthesized default is
      // the module namespace itself — the bundler-convention interop value.
      const target = JSON.stringify(id.slice(NS_DEFAULT_PREFIX.length));
      return {
        code: `import * as __ns from ${target};\nexport * from ${target};\nexport default __ns;`,
        map: null,
      };
    }
    // Only handle VFS paths; let other plugins (e.g. node-shim) handle their own virtual schemes.
    if (!id.startsWith("/")) return null;
    const ext = extname(id);
    let contents = vfs.hot.readFileSync(id, "utf8") as string;
    const resolveDir = dirname(id);
    if (ext === ".json") {
      try {
        JSON.parse(contents);
        // Valid JSON goes to rolldown's native JSON module handling — feeding
        // it a pre-wrapped `export default` makes its serde_json parser fail
        // with "expected value at line 1 column 1" on every .json import
        // (express, body-parser, koa, ajv, ...).
        return { code: contents, map: null, moduleType: "json", moduleSideEffects: "no-treeshake" };
      } catch {
        // Not actually JSON — empty tarball file, JSONC, or a non-JSON file
        // reached via the .json extension guess. Degrade to an empty object
        // rather than failing the whole bundle.
        warnings?.push(`"${id}" has a .json extension but is not valid JSON — exporting {}`);
        // moduleType must be pinned — rolldown otherwise re-infers "json" from
        // the extension and feeds this JS back to its JSON parser.
        return {
          code: "export default {};",
          map: null,
          moduleType: "js",
          moduleSideEffects: "no-treeshake",
        };
      }
    }
    // Strip shebangs — `#!/usr/bin/env node` bin entries (dotenv, parcel) are
    // not parseable JS.
    if (contents.startsWith("#!")) contents = contents.replace(/^#![^\n]*(\n|$)/, "");
    // Prepend __dirname/__filename for CJS-style implicit globals
    const prelude =
      implicitGlobalDecl("__filename", JSON.stringify(id), contents) +
      implicitGlobalDecl("__dirname", JSON.stringify(resolveDir), contents);
    return {
      code: (prelude ? prelude + "\n" : "") + contents,
      map: null,
      moduleSideEffects: "no-treeshake",
    };
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

const registryShimExpr = (name: string): string =>
  `globalThis.__browserContainers.shims[${JSON.stringify(name)}]`;

/**
 * Locates the live shim backing a builtin, along with the bundle-runtime
 * expression that re-reads it from `globalThis.__browserContainers.shims`.
 * Subpath builtins (`fs/promises`, `assert/strict`, `util/types`, ...) try
 * three shapes in order: a registry key of their own (e.g. `timers/promises`),
 * a property on the parent shim (`fs.promises`, `path.posix`), and — for the
 * entries in SUBPATH_SELF_ALIASES — the parent object itself.
 */
const resolveShim = (
  builtin: string,
  getShim?: (builtin: string) => Record<string, unknown> | undefined,
): { expr: string; shim: Record<string, unknown> } | undefined => {
  const direct = getShim?.(builtin);
  if (direct) return { expr: registryShimExpr(builtin), shim: direct };

  const slash = builtin.indexOf("/");
  if (slash !== -1) {
    const parentName = builtin.slice(0, slash);
    const sub = builtin.slice(slash + 1);
    const selfAlias = SUBPATH_SELF_ALIASES[builtin];
    const lookupName = selfAlias ?? parentName;
    const parent = getShim?.(lookupName);
    if (parent) {
      if (selfAlias) return { expr: registryShimExpr(lookupName), shim: parent };
      const child = parent[sub];
      // `assert.strict` is a callable function-object, so accept functions too.
      if (child && (typeof child === "object" || typeof child === "function")) {
        return {
          expr: `${registryShimExpr(lookupName)}[${JSON.stringify(sub)}]`,
          shim: child as Record<string, unknown>,
        };
      }
    }
  }

  // `node:console` resolves to the banner's process-routed console — there is
  // no registry shim for it. The `__bc_console` reference binds to the
  // banner's injected binding inside the single-file bundle scope.
  if (builtin === "console") return { expr: "__bc_console", shim: {} };
  return undefined;
};

const nodeAliasPlugin = (
  getShim?: (builtin: string) => Record<string, unknown> | undefined,
  warnings?: string[],
): Plugin => ({
  name: "bolo-node-alias",
  async resolveId(id) {
    const builtin = id.startsWith("node:") ? id.slice(5) : id;
    if (!NODE_BUILTIN_NAMES.has(builtin)) return null;

    const resolved = resolveShim(builtin, getShim);
    if (!resolved) {
      warnings?.push(`no browser shim registered for node builtin "node:${builtin}"`);
      return { id, external: true };
    }
    return `bolo-node-shim:${builtin}`;
  },
  async load(id) {
    if (!id.startsWith("bolo-node-shim:")) return null;
    const builtin = id.slice("bolo-node-shim:".length);
    const resolved = resolveShim(builtin, getShim);
    if (!resolved) {
      // Unsupported builtins are left external in resolveId; this branch is defensive.
      return {
        code: `throw new Error("Unsupported node builtin \\"node:${builtin}\\" — no browser shim is registered for it.");`,
        map: null,
      };
    }
    const keys =
      builtin === "console"
        ? BANNER_CONSOLE_KEYS
        : Object.keys(resolved.shim).filter((k) => VALID_JS_IDENTIFIER.test(k));
    const contents = shimModuleSource(builtin, keys, resolved.expr);
    return { code: contents, map: null };
  },
});

/**
 * Source of the virtual module that re-exports a container's live builtin
 * shim. `shimExpr` is the bundle-scope expression yielding the shim object —
 * normally a `__browserContainers.shims[...]` lookup, but subpath aliases read
 * one level deeper (`shims["fs"]["promises"]`) and `console` binds to the
 * banner global.
 */
export const shimModuleSource = (builtin: string, keys: string[], shimExpr?: string): string =>
  [
    `const __shim = ${shimExpr ?? registryShimExpr(builtin)};`,
    "export default __shim;",
    // Node's CJS interop: require('assert') is the shim itself, so callable
    // builtins (assert, ...) work as `assert(cond)`.
    'export { __shim as "module.exports" };',
    ...keys.map((k) => `export const ${k} = __shim[${JSON.stringify(k)}];`),
  ].join("\n");

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
      vfsPlugin(options.vfs, warnings),
      nodeAliasPlugin(options.getShim, warnings),
      esmShFallbackPlugin(options.vfs, warnings),
    ],
    transform: {
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.browser": "true",
        // Free references to the timer globals resolve to the banner's injected
        // bindings. They are renamed (and only unbound references rewritten) so a
        // program's own top-level `const { setTimeout } = ...` cannot collide.
        ...Object.fromEntries(TIMER_GLOBALS.map((n) => [n, `__bc_${n}`])),
        // Same trick for the injected Node globals — a bundled module that
        // declares its own `Buffer`/`process`/`console` binding is untouched
        // (define only rewrites unbound references), and the banner never
        // claims the well-known name, so no redeclare error is possible.
        process: "__bc_process",
        Buffer: "__bc_Buffer",
        global: "__bc_global",
        console: "__bc_console",
      },
    },
    onLog(level, log, _logger) {
      if (level !== "warn") return;
      // Rolldown's EVAL warning ("Use of direct eval") fires for Node core
      // tests that legitimately probe eval scoping; the bundle still runs —
      // eval executes in the bundle's function scope, which is the same
      // limitation indirect eval has always had here. Don't surface it as a
      // build warning or compat runs fail on an informational notice.
      const message = String(log);
      if (message.includes("[EVAL]")) return;
      warnings.push(message);
    },
  });

  const result = await bundle.generate({
    format: "es",
    banner: GLOBALS_BANNER,
    // The bundle executes from a single data:/blob: URL — relative chunk
    // imports (dynamic import() splitting) would be unresolvable.
    inlineDynamicImports: true,
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
  // ponytail: use transformSync to bypass the napi async-work queue entirely.
  // Even with asyncWorkPoolSize: 0, sync avoids any chance of queue starvation;
  // cost is main-thread block for tens of ms per file, irrelevant for preview.
  const result = oxc.transformSync(`input.${lang}`, code, { sourceType: "module" });
  if (result.errors?.length) {
    throw new Error(result.errors.map((e: any) => e.message).join("\n"));
  }
  return {
    code: result.code,
    warnings: result.errors?.map((e: any) => e.message) ?? [],
  };
};
