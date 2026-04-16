import type { Plugin } from "vite";

const SHIMMED_BUILTINS = new Set([
  "buffer",
  "crypto",
  "events",
  "http",
  "os",
  "path",
  "stream",
  "url",
  "worker_threads",
]);

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
      const bareName = id.startsWith("node:")
        ? id.slice("node:".length)
        : id;

      if (SHIMMED_BUILTINS.has(bareName)) {
        return `${pkgRoot}/dist/${bareName}.js`;
      }

      if (id.startsWith("unenv/runtime/node/")) {
        const mod = id.slice("unenv/runtime/node/".length);
        const resolved = await this.resolve(
          `unenv/runtime/node/${mod}/index`,
          importer,
          { ...options, skipSelf: true }
        );
        if (resolved) {
          return resolved.id;
        }
      }

      return null;
    },
  };
};

