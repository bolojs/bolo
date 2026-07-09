import type { VfsBus } from "@browser-containers/vfs-bus";

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
  "events",
  "fs",
  "fs/promises",
  "http",
  "net",
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
  "worker_threads",
  "zlib",
];

// Real node builtins with no feasible browser implementation (raw TCP/UDP
// sockets, a VM sandbox, native clustering). `isBuiltin` still recognizes
// them — a real node app importing them is a legitimate builtin reference —
// but `require`/the bundler's node-alias plugin reject them with a message
// that names the actual constraint instead of the generic "unknown npm
// package" fallback.
const UNSUPPORTED_BUILTIN_NAMES = ["vm", "dgram", "tls", "cluster"];

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
  const { vfs, getShim } = options;

  const createRequire = (filename: string) => {
    const require = (specifier: string): unknown => {
      const bare = stripNodePrefix(specifier);
      if (UNSUPPORTED_BUILTIN_NAMES.includes(bare)) {
        throw new Error(
          `require("${specifier}") is a node builtin with no browser-compatible implementation ` +
            `("${bare}" needs a capability the browser sandbox cannot provide) and will never be supported here.`,
        );
      }
      if (BUILTIN_MODULE_NAMES.includes(bare)) {
        const shim = getShim(bare);
        if (shim) return shim;
        throw new Error(
          `require("${specifier}") has no browser shim registered for node builtin "${bare}".`,
        );
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

  return {
    createRequire,
    builtinModules: BUILTIN_MODULE_NAMES,
    isBuiltin: (id: string): boolean =>
      id.startsWith("node:") ||
      BUILTIN_MODULE_NAMES.includes(id) ||
      UNSUPPORTED_BUILTIN_NAMES.includes(id),
  };
};

export type ModuleShim = ReturnType<typeof createModuleShim>;
