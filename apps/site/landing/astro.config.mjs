import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@astrojs/react";
import solid from "@astrojs/solid-js";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { nodeWebShims } from "@bolojs/node-web-shims/vite-plugin";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const shimsDir = fileURLToPath(new URL("../../../packages/node-web-shims/dist/", import.meta.url));
const requireFromNodeWebShims = createRequire(
  fileURLToPath(new URL("../../../packages/node-web-shims/package.json", import.meta.url)),
);
const streamPromisesShim = requireFromNodeWebShims.resolve("unenv/node/stream/promises");

const requireFromApp = createRequire(import.meta.url);
const resolvePolyfillsShim = () => ({
  name: "resolve-polyfills-shims",
  enforce: "pre",
  resolveId(source) {
    if (source.startsWith("vite-plugin-node-polyfills/shims/")) {
      const resolved = requireFromApp.resolve(source);
      const esm = resolved.replace(/\.cjs$/, ".js");
      return existsSync(esm) ? esm : resolved;
    }
    return null;
  },
});

export default defineConfig({
  site: process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : "https://bolojs.pages.dev",
  integrations: [
    react({ include: ["**/shared/components/**/*"], exclude: ["**/demo/**/*"] }),
    solid({ include: ["**/demo/**/*"] }),
  ],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  vite: {
    plugins: [
      tailwindcss(),
      resolvePolyfillsShim(),
      nodeWebShims(),
      nodePolyfills({
        include: ["buffer"],
        globals: { Buffer: true, global: true, process: true },
      }),
    ],
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
    build: {
      target: "esnext",
      rollupOptions: {
        external: ["typescript", "oxc-transform", "sass", "@swc/wasm-web"],
        output: {
          manualChunks(id) {
            if (id.includes("quickjs-emscripten") || id.includes("@jitl/")) return "quickjs";
            if (id.includes("memfs")) return "memfs";
            if (id.includes("@bolojs/npm") || id.includes("@unjs/lockfile")) return "npm";
          },
        },
      },
    },
    resolve: {
      alias: [
        { find: "node:stream/promises", replacement: streamPromisesShim },
        { find: /^node:events$/, replacement: `${shimsDir}events.js` },
        { find: /^node:net$/, replacement: requireFromNodeWebShims.resolve("unenv/node/net") },
        { find: /^node:path$/, replacement: `${shimsDir}path.js` },
        { find: /^node:stream$/, replacement: `${shimsDir}stream.js` },
        { find: /^node:async_hooks$/, replacement: `${shimsDir}async_hooks.js` },
        { find: /^crypto$/, replacement: `${shimsDir}crypto.js` },
        { find: /^events$/, replacement: `${shimsDir}events.js` },
        { find: /^path$/, replacement: `${shimsDir}path.js` },
        { find: /^stream$/, replacement: `${shimsDir}stream.js` },
        { find: /^util$/, replacement: `${shimsDir}util.js` },
        { find: /^assert$/, replacement: `${shimsDir}assert.js` },
        { find: /^os$/, replacement: `${shimsDir}os.js` },
        { find: /^tty$/, replacement: `${shimsDir}tty.js` },
      ],
    },
    optimizeDeps: {
      exclude: ["@bolojs/runtime", "@rolldown/browser", "oxc-transform"],
      esbuildOptions: {
        plugins: [
          {
            name: "resolve-bare-builtins",
            setup(build) {
              const bare = ["crypto", "events", "path", "stream", "util", "assert", "os", "tty"];
              for (const name of bare) {
                build.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({
                  path: `${shimsDir}${name}.js`,
                }));
              }
            },
          },
        ],
      },
    },
  },
});
