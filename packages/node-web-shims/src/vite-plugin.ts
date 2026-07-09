import type { Plugin } from "vite";

// Builtins with a first-party wrapper in this package's `src/`.
const SHIMMED_BUILTINS = new Set([
  "async_hooks",
  "buffer",
  "crypto",
  "events",
  "http",
  "os",
  "path",
  "querystring",
  "stream",
  "url",
  "util",
  "worker_threads",
  "string_decoder",
  "tty",
  "assert",
  "zlib",
  "constants",
  "perf_hooks",
  "timers",
  "punycode",
  "diagnostics_channel",
  "readline",
]);

// Subset of SHIMMED_BUILTINS actually backed by unenv (worker_threads uses a
// bespoke threads.js wrapper instead). unenv's own runtime modules sometimes
// import their own deep subpaths directly (e.g. `stream.mjs` imports
// `node:stream/promises`), expecting the consumer's bundler to alias those
// too — so any subpath of one of these is routed to unenv's own module
// rather than requiring a dedicated wrapper file per subpath.
const UNENV_BACKED_BUILTINS = new Set(SHIMMED_BUILTINS);
UNENV_BACKED_BUILTINS.delete("worker_threads");

/**
 * Creates a Vite plugin that aliases node:* modules to browser-compatible shims.
 *
 * This plugin should be used when bundling Node.js applications for the browser,
 * particularly for the RuntimeWorker bundle.
 */
export const nodeWebShims = (): Plugin => {
  const pkgRoot = new URL("..", import.meta.url).pathname;

  return {
    name: "@browser-containers/node-web-shims",
    enforce: "pre",
    async resolveId(id, importer, options) {
      const bareName = id.startsWith("node:") ? id.slice("node:".length) : id;

      if (SHIMMED_BUILTINS.has(bareName)) {
        return `${pkgRoot}/dist/${bareName}.js`;
      }

      const topLevel = bareName.split("/")[0];
      if (bareName !== topLevel && UNENV_BACKED_BUILTINS.has(topLevel)) {
        const resolved = await this.resolve(`unenv/node/${bareName}`, importer, {
          ...options,
          skipSelf: true,
        });
        if (resolved) {
          return resolved.id;
        }
      }

      return null;
    },
  };
};
