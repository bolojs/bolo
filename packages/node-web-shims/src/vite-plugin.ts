import type { Plugin } from "vite";

/**
 * Creates a Vite plugin that aliases node:* modules to browser-compatible shims.
 *
 * This plugin should be used when bundling Node.js applications for the browser,
 * particularly for the RuntimeWorker bundle.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vite';
 * import { nodeWebShims } from '@browser-containers/node-web-shims/vite-plugin';
 *
 * export default defineConfig({
 *   plugins: [nodeWebShims()]
 * });
 * ```
 */
export const nodeWebShims = (): Plugin => {
  return {
    name: "@browser-containers/node-web-shims",
    enforce: "pre",
    resolveId(id) {
      if (id.startsWith("node:")) {
        const pkgRoot = new URL("..", import.meta.url).pathname;
        return `${pkgRoot}/dist/${id.slice("node:".length)}.js`;
      }
      if (id.startsWith("unenv/")) {
        const pkgRoot = new URL("..", import.meta.url).pathname;
        return `${pkgRoot}/node_modules/${id}/index.mjs`;
      }
      return null;
    },
  };
};

export default nodeWebShims;
