import type { VfsBus } from "@bolojs/fs";
import {
  registerWasmTool,
  createWasmRegistry,
  type WasmTool,
  type WasmToolResult,
  type WasmToolLoader,
} from "./registry.js";
import { loadBinary, BINARY_MANIFEST } from "./binary-loader.js";
import { buildEsmShUrl } from "@bolojs/pm";

/**
 * Curated WASM/JS CLI tools registered into the realm-local
 * `registerWasmTool` registry. The registry is a module singleton per realm
 * (process workers are separate realms — see node-process-worker.ts), so
 * registration is a function callers invoke per realm, not a side effect of
 * importing this module.
 */

export type CuratedModuleLoader = (specifier: string) => Promise<unknown>;

/**
 * esm.sh CDN loader — same fallback `bundle.ts` uses for bare specifiers the
 * installed `node_modules` cannot satisfy. Tool glue packages are loaded on
 * demand (first dispatch), never at import time. Returns the raw module
 * namespace; callers apply their own default-export interop because the
 * glue packages mix default and named exports differently.
 */
export const esmShModuleLoader: CuratedModuleLoader = async (specifier: string) =>
  import(/* @vite-ignore */ buildEsmShUrl(specifier));

export interface CuratedToolsOptions {
  readonly vfs: VfsBus;
  /** Injectable module loader — tests substitute a fake; production uses esm.sh. */
  readonly loadModule?: CuratedModuleLoader;
  /**
   * Injectable wasm-binary loader (defaults to the OPFS-backed
   * `loadBinary`). Tests substitute a stub so dispatch never touches the
   * network.
   */
  readonly loadWasmBinary?: (
    name: string,
    version: string,
    filename: string,
  ) => Promise<Uint8Array>;
}

const manifestVersion = (name: string): string | undefined =>
  BINARY_MANIFEST.find((m) => m.name === name)?.version;

const fail = (stderr: string, exitCode = 1): WasmToolResult => ({
  stdout: "",
  stderr,
  exitCode,
});

const unsupportedFlag = (tool: string, flag: string): WasmToolResult =>
  fail(
    `${tool}: unsupported flag "${flag}" in the browser WASM tool (v1 covers ` +
      `single-file transform only — no bundling, watching, or serving).\n`,
  );

// ── Shared argv helpers ────────────────────────────────────────────────

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

/**
 * Minimal POSIX-ish argv split: `--key=value` / `--key` / `-o<path>` /
 * `-o <path>` / positionals. Anything fancier (--flag value pairs, `=` in
 * short flags) is rejected downstream as an unsupported flag rather than
 * misparsed.
 */
const parseArgs = (args: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) flags.set(arg.slice(2), true);
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (arg === "-o") {
      const next = args[++i];
      if (next === undefined) flags.set("outfile", true);
      else flags.set("outfile", next);
    } else if (arg.startsWith("-o") && arg.length > 2) {
      flags.set("outfile", arg.slice(2));
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
};

const flagString = (flags: Map<string, string | true>, name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};

const hasFlag = (flags: Map<string, string | true>, name: string): boolean => flags.has(name);

const extname = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const dirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
};

const joinPath = (dir: string, file: string): string => {
  if (file.startsWith("/")) return file;
  return `${dir === "/" ? "" : dir}/${file}`;
};

const absPath = (path: string): string => (path.startsWith("/") ? path : joinPath("/", path));

const writeVfsFile = (vfs: VfsBus, path: string, contents: string | Uint8Array): void => {
  const dir = dirname(path);
  if (dir !== "/" && !vfs.hot.existsSync(dir)) {
    vfs.hot.mkdirSync(dir, { recursive: true });
  }
  vfs.hot.writeFileSync(path, contents);
};

/**
 * Picks the usable API surface out of a glue module. esm.sh interop differs
 * per package: some expose the API as named exports, some wrap everything in
 * `default`, some do both. Prefer whichever shape actually carries the
 * expected methods.
 */
const pickModule = <T>(raw: unknown, methods: string[]): T => {
  const mod = raw as Record<string, unknown> | undefined;
  const def = mod?.default as Record<string, unknown> | undefined;
  if (def && typeof def === "object" && methods.some((m) => typeof def[m] === "function")) {
    return def as unknown as T;
  }
  if (mod && methods.some((m) => typeof mod[m] === "function")) return mod as unknown as T;
  return (def ?? mod) as unknown as T;
};

// ── esbuild ────────────────────────────────────────────────────────────

interface EsbuildTransformOptions {
  loader?: string;
  target?: string;
  format?: string;
  minify?: boolean;
  sourcemap?: boolean | string;
  sourcefile?: string;
  jsx?: string;
  jsxFactory?: string;
  jsxFragment?: string;
  legalComments?: string;
  charset?: string;
}

interface EsbuildModule {
  readonly version: string;
  initialize(options?: { wasmURL?: string }): Promise<void>;
  transform(
    input: string,
    options?: EsbuildTransformOptions,
  ): Promise<{
    code: string;
    map?: string;
  }>;
}

/** Flags the v1 tool understands; anything else is rejected explicitly. */
const ESBUILD_SUPPORTED_FLAGS = new Set([
  "version",
  "v",
  "help",
  "loader",
  "target",
  "format",
  "minify",
  "sourcemap",
  "sourcefile",
  "jsx",
  "jsx-factory",
  "jsx-fragment",
  "legal-comments",
  "charset",
  "outfile",
  "outdir",
  "log-level",
  "color",
  "no-color",
]);

const ESBUILD_KNOWN_BUT_UNSUPPORTED = new Set([
  "bundle",
  "splitting",
  "serve",
  "watch",
  "metafile",
  "analyze",
  "inject",
  "external",
  "alias",
  "define",
  "pure",
  "drop",
  "tree-shaking",
  "keep-names",
  "mangle-props",
  "reserve-props",
  "ignore-annotations",
  "tsconfig",
  "tsconfig-raw",
  "footer",
  "banner",
  "entry-names",
  "chunk-names",
  "asset-names",
  "out-extension",
  "public-path",
  "global-name",
  "footer-raw",
  "banner-raw",
  "supported",
  "conditions",
  "main-fields",
  "resolve-extensions",
  "preserve-symlinks",
  "allow-overwrite",
  "incremental",
  "write",
]);

const EXTENSION_LOADERS: Record<string, string> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".json": "json",
  ".css": "css",
  ".txt": "text",
  ".data": "binary",
  ".wasm": "file",
};

const createEsbuildTool = (options: CuratedToolsOptions): WasmToolLoader => {
  const loadModule = options.loadModule ?? esmShModuleLoader;
  const loadWasm = options.loadWasmBinary ?? loadBinary;
  const version = manifestVersion("esbuild-wasm") ?? "0.20.2";
  let modulePromise: Promise<EsbuildModule> | undefined;

  const getModule = async (): Promise<EsbuildModule> => {
    modulePromise ??= (async () => {
      const raw = await loadModule(`esbuild-wasm@${version}`);
      const mod = pickModule<EsbuildModule>(raw, ["initialize", "transform"]);
      // esbuild-wasm's initialize() accepts { wasmURL }; feed it the binary
      // through the shared OPFS-backed loadBinary cache as a blob URL so the
      // "install once, stay local" path covers the glue's wasm too.
      const bytes = await loadWasm("esbuild-wasm", version, "esbuild.wasm");
      const wasmURL = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "application/wasm" }),
      );
      try {
        await mod.initialize({ wasmURL });
      } catch {
        // Older esbuild-wasm builds reject/fail on wasmURL — retry bare.
        await mod.initialize();
      }
      return mod;
    })();
    return modulePromise;
  };

  return async (): Promise<WasmTool> => ({
    async run(args: string[], stdin?: string): Promise<WasmToolResult> {
      const { positionals, flags } = parseArgs(args);

      if (hasFlag(flags, "version") || hasFlag(flags, "v")) {
        // The package version IS the tool version for esbuild-wasm — answer
        // without initializing the wasm module.
        return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
      }
      if (hasFlag(flags, "help")) {
        return {
          stdout:
            "esbuild (browser WASM build, v1)\n" +
            "Usage: esbuild <file> [--loader:.ext=loader|--loader=loader] " +
            "[--target=..] [--format=..] [--minify] [--sourcemap] [-o|--outfile=path]\n",
          stderr: "",
          exitCode: 0,
        };
      }

      // Reject unknown flags explicitly rather than silently dropping them —
      // a CLI that ignores --bundle would produce wrong output quietly.
      for (const key of flags.keys()) {
        if (key.startsWith("loader:") || key === "loader") continue;
        if (ESBUILD_SUPPORTED_FLAGS.has(key)) continue;
        if (ESBUILD_KNOWN_BUT_UNSUPPORTED.has(key)) {
          return fail(`esbuild: --${key} is not supported in the browser WASM tool (v1).\n`);
        }
        return unsupportedFlag("esbuild", `--${key}`);
      }

      if (positionals.length > 1) {
        return fail(
          "esbuild: multiple entry points are not supported in the browser WASM tool (v1).\n",
        );
      }

      const mod = await getModule();

      // stdin mode: `echo 'code' | esbuild --loader=ts`
      let input: string;
      let sourcefile: string | undefined = flagString(flags, "sourcefile");
      let defaultLoader = "js";
      if (positionals.length === 0) {
        if (stdin === undefined) {
          return fail("esbuild: no input file and no stdin.\n");
        }
        input = stdin;
      } else {
        const file = positionals[0];
        const abs = absPath(file);
        if (!options.vfs.hot.existsSync(abs)) {
          return fail(`esbuild: could not read "${file}" from the virtual filesystem.\n`);
        }
        input = options.vfs.hot.readFileSync(abs, "utf8") as string;
        sourcefile ??= abs;
        defaultLoader = EXTENSION_LOADERS[extname(abs)] ?? "js";
      }

      // --loader:.ts=tsx maps an extension to a loader (the extension rides
      // in the flag NAME after "loader:", the loader in the value); a bare
      // --loader=ts applies to stdin/unknown extensions.
      const loaderMap = new Map<string, string>();
      for (const [key, spec] of flags) {
        if (!key.startsWith("loader:") || typeof spec !== "string") continue;
        const ext = key.slice("loader:".length);
        loaderMap.set(ext.startsWith(".") ? ext : `.${ext}`, spec);
      }
      const stdinLoader = flagString(flags, "loader");
      const loader =
        (sourcefile && loaderMap.get(extname(sourcefile))) ?? stdinLoader ?? defaultLoader;

      const transformOptions: EsbuildTransformOptions = { loader };
      const target = flagString(flags, "target");
      if (target) transformOptions.target = target;
      const format = flagString(flags, "format");
      if (format) transformOptions.format = format;
      if (hasFlag(flags, "minify")) transformOptions.minify = true;
      const sourcemapFlag = flags.get("sourcemap");
      if (sourcemapFlag !== undefined) {
        transformOptions.sourcemap =
          sourcemapFlag === "false"
            ? false
            : typeof sourcemapFlag === "string" && sourcemapFlag !== ""
              ? sourcemapFlag
              : true;
      }
      if (sourcefile) transformOptions.sourcefile = sourcefile;
      const jsx = flagString(flags, "jsx");
      if (jsx) transformOptions.jsx = jsx;
      const jsxFactory = flagString(flags, "jsx-factory");
      if (jsxFactory) transformOptions.jsxFactory = jsxFactory;
      const jsxFragment = flagString(flags, "jsx-fragment");
      if (jsxFragment) transformOptions.jsxFragment = jsxFragment;
      const legalComments = flagString(flags, "legal-comments");
      if (legalComments) transformOptions.legalComments = legalComments;
      const charset = flagString(flags, "charset");
      if (charset) transformOptions.charset = charset;

      let result: { code: string; map?: string };
      try {
        result = await mod.transform(input, transformOptions);
      } catch (err) {
        return fail(`esbuild: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      const outfile = flagString(flags, "outfile");
      const outdir = flagString(flags, "outdir");
      if (outfile !== undefined || outdir !== undefined) {
        let outPath: string;
        if (outfile !== undefined && outfile !== "") {
          outPath = absPath(outfile);
        } else {
          const name = sourcefile ? basename(sourcefile).replace(/\.[^.]+$/, ".js") : "out.js";
          outPath = joinPath(absPath(outdir ?? "/"), name);
        }
        writeVfsFile(options.vfs, outPath, result.code);
        if (result.map && transformOptions.sourcemap === "external") {
          writeVfsFile(options.vfs, `${outPath}.map`, result.map);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      return { stdout: result.code, stderr: "", exitCode: 0 };
    },
  });
};

// ── swc ────────────────────────────────────────────────────────────────

interface SwcModule {
  readonly version?: string;
  transform(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{ code: string; map?: string }>;
}

const SWC_SUPPORTED_FLAGS = new Set([
  "version",
  "v",
  "help",
  "filename",
  "outfile",
  "output",
  "output-file",
  "config-file",
  "env-name",
  "log-level",
  "color",
  "no-color",
  "watch",
  "copy-files",
  "strip-leading-paths",
  "source-maps",
  "source-file-name",
  "module-type",
]);

const SWC_KNOWN_BUT_UNSUPPORTED = new Set([
  "bundle",
  "out-dir",
  "out-file",
  "sync",
  "workers",
  "verbose",
  "quiet",
  "silent",
  "no-swcrc",
  "swcrc",
  "ignore",
  "delete-dir-on-start",
  "extensions",
  "compile",
  "error-codes",
]);

const swcSyntaxFor = (file: string): { syntax: string; tsx?: boolean; jsx?: boolean } => {
  const ext = extname(file);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return { syntax: "typescript" };
  if (ext === ".tsx") return { syntax: "typescript", tsx: true };
  if (ext === ".jsx") return { syntax: "ecmascript", jsx: true };
  return { syntax: "ecmascript" };
};

const createSwcTool = (options: CuratedToolsOptions): WasmToolLoader => {
  const loadModule = options.loadModule ?? esmShModuleLoader;
  const loadWasm = options.loadWasmBinary ?? loadBinary;
  const version = manifestVersion("@swc/wasm-web") ?? "1.15.24";
  let modulePromise: Promise<SwcModule> | undefined;

  const getModule = async (): Promise<SwcModule> => {
    modulePromise ??= (async () => {
      const raw = (await loadModule(`@swc/wasm-web@${version}`)) as Record<string, unknown>;
      // @swc/wasm-web's default export initializes the wasm instance; named
      // exports (transform, transformSync, ...) live on the namespace. esm.sh
      // interop can put either shape under `default`, so probe both.
      const init = typeof raw.default === "function" && !raw.transform ? raw.default : undefined;
      const unwrapped: unknown = raw.default && typeof raw.default === "object" ? raw.default : raw;
      const ns = (init ? raw : unwrapped) as Record<string, unknown>;
      if (init) {
        const bytes = await loadWasm("@swc/wasm-web", version, "wasm_bg.wasm");
        await (init as (input?: unknown) => Promise<unknown>)(bytes);
      }
      return ns as unknown as SwcModule;
    })();
    return modulePromise;
  };

  return async (): Promise<WasmTool> => ({
    async run(args: string[], stdin?: string): Promise<WasmToolResult> {
      const { positionals, flags } = parseArgs(args);

      if (hasFlag(flags, "version") || hasFlag(flags, "v")) {
        return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
      }
      if (hasFlag(flags, "help")) {
        return {
          stdout:
            "swc (browser WASM build, v1)\n" +
            "Usage: swc <file> [--filename=name] [-o|--outfile=path]\n",
          stderr: "",
          exitCode: 0,
        };
      }

      for (const key of flags.keys()) {
        if (SWC_SUPPORTED_FLAGS.has(key)) continue;
        if (SWC_KNOWN_BUT_UNSUPPORTED.has(key)) {
          return fail(`swc: --${key} is not supported in the browser WASM tool (v1).\n`);
        }
        return unsupportedFlag("swc", `--${key}`);
      }

      if (positionals.length > 1) {
        return fail("swc: multiple input files are not supported in the browser WASM tool (v1).\n");
      }

      let code: string;
      let filename = flagString(flags, "filename");
      if (positionals.length === 0) {
        if (stdin === undefined) return fail("swc: no input file and no stdin.\n");
        code = stdin;
        filename ??= "stdin.js";
      } else {
        const file = positionals[0];
        const abs = absPath(file);
        if (!options.vfs.hot.existsSync(abs)) {
          return fail(`swc: could not read "${file}" from the virtual filesystem.\n`);
        }
        code = options.vfs.hot.readFileSync(abs, "utf8") as string;
        filename ??= abs;
      }

      const mod = await getModule();
      const syntax = swcSyntaxFor(filename ?? "stdin.js");
      let result: { code: string; map?: string };
      try {
        result = await mod.transform(code, {
          filename: filename ?? "stdin.js",
          jsc: {
            parser: syntax,
            target: "es2022",
          },
          sourceMaps:
            hasFlag(flags, "source-maps") || flagString(flags, "source-file-name") !== undefined,
        });
      } catch (err) {
        return fail(`swc: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      const outfile =
        flagString(flags, "outfile") ??
        flagString(flags, "output") ??
        flagString(flags, "output-file");
      if (outfile) {
        writeVfsFile(options.vfs, absPath(outfile), result.code);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: result.code, stderr: "", exitCode: 0 };
    },
  });
};

// ── Registration ───────────────────────────────────────────────────────

/**
 * Registers the curated tool set (`esbuild`, `swc`) into the realm-local
 * `registerWasmTool` registry. Idempotent — safe to call once per realm
 * (main thread, each process worker) before `createWasmRegistry()`.
 */
export const registerCuratedWasmTools = (options: CuratedToolsOptions): void => {
  registerWasmTool("esbuild", createEsbuildTool(options));
  registerWasmTool("swc", createSwcTool(options));
};

/**
 * Convenience: register the curated set for `vfs`, then return a registry
 * bound to the (now-populated) realm-local tool table.
 */
export const createCuratedWasmRegistry = (
  options: CuratedToolsOptions,
): ReturnType<typeof createWasmRegistry> => {
  registerCuratedWasmTools(options);
  return createWasmRegistry();
};

export type { WasmTool, WasmToolResult, WasmToolLoader };
