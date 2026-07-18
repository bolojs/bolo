import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin, UserConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { nodeWebShims } from "@bolojs/node-web-shims/vite-plugin";

const requireFromPreset = createRequire(import.meta.url);

// Resolve node-web-shims' own dist/ and its unenv dependency by package name
// rather than by relative path depth, so this works from any consumer's
// location in the workspace (not just apps/site/landing's original nesting).
const nodeWebShimsPkgPath = requireFromPreset.resolve("@bolojs/node-web-shims/package.json");
const shimsDir = nodeWebShimsPkgPath.replace(/package\.json$/, "dist/");
const requireFromNodeWebShims = createRequire(nodeWebShimsPkgPath);
const streamPromisesShim = requireFromNodeWebShims.resolve("unenv/node/stream/promises");

const requireFromApp = createRequire(import.meta.url);
const resolvePolyfillsShim = (): Plugin => ({
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

/**
 * Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers required
 * for cross-origin isolation (SharedArrayBuffer, the sw-sandbox worker
 * bridge). Apply to both the dev server and any static host serving the
 * build output.
 */
export const coopCoepHeaders: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

const BARE_BUILTINS = ["crypto", "events", "path", "stream", "util", "assert", "os", "tty"];

/**
 * Vite plugins that alias Node builtins to browser-compatible shims for any
 * consumer of `@bolojs/runtime`. Combines the package's own shim-resolution
 * plugin with `vite-plugin-node-polyfills` for `Buffer`/`process` globals.
 *
 * `Buffer` is deliberately excluded from `globals` here — installing it
 * per-module collides when the same module graph is hydrated more than once
 * on a page (`Identifier '__buffer_polyfill' has already been declared`).
 * Install it once yourself via a `globalThis.Buffer = ...` shim imported
 * before any other module (see the app-builder example's
 * `client-globals.ts`).
 */
export function bolojsShimPlugins(): Plugin[] {
  return [
    resolvePolyfillsShim(),
    nodeWebShims(),
    ...nodePolyfills({
      include: ["buffer"],
      globals: { Buffer: false, global: false, process: true },
    }),
  ];
}

/** `resolve.alias` entries backing the shim plugins above for bare/`node:` specifiers. */
export function bolojsAlias(): Array<{ find: string | RegExp; replacement: string }> {
  const shim = (name: string) => `${shimsDir}${name}.js`;
  return [
    { find: "node:stream/promises", replacement: streamPromisesShim },
    { find: /^node:events$/, replacement: shim("events") },
    { find: /^node:net$/, replacement: requireFromNodeWebShims.resolve("unenv/node/net") },
    { find: /^node:path$/, replacement: shim("path") },
    { find: /^node:stream$/, replacement: shim("stream") },
    { find: /^node:async_hooks$/, replacement: shim("async_hooks") },
    ...BARE_BUILTINS.map((name) => ({ find: new RegExp(`^${name}$`), replacement: shim(name) })),
  ];
}

/** `optimizeDeps` config so esbuild's dependency pre-bundling scan also resolves bare builtins to shims. */
export function bolojsOptimizeDeps(): UserConfig["optimizeDeps"] {
  return {
    exclude: ["@bolojs/runtime", "@rolldown/browser", "oxc-transform"],
    esbuildOptions: {
      plugins: [
        {
          name: "resolve-bare-builtins",
          setup(build) {
            for (const name of BARE_BUILTINS) {
              build.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({
                path: `${shimsDir}${name}.js`,
              }));
            }
          },
        },
      ],
    },
  };
}

/**
 * Full Vite config fragment for consumers of `@bolojs/runtime`: the shim
 * plugins, `resolve.alias`, `optimizeDeps`, cross-origin-isolation dev
 * headers, and the `build.rollupOptions` exclusions/chunking those shims
 * need at build time. Spread this into your own `defineConfig({ ... })`
 * (arrays/objects merge shallowly — merge `plugins` yourself if you have
 * your own).
 */
export function bolojsPreset(): UserConfig {
  return {
    plugins: bolojsShimPlugins(),
    server: {
      headers: coopCoepHeaders,
    },
    preview: {
      headers: coopCoepHeaders,
    },
    resolve: {
      alias: bolojsAlias(),
    },
    optimizeDeps: bolojsOptimizeDeps(),
    build: {
      target: "esnext",
      rollupOptions: {
        external: [
          "typescript",
          "oxc-transform",
          "@oxc-transform/binding-wasm32-wasi",
          "@oxc-transform/binding",
          "sass",
          "@swc/wasm-web",
        ],
        output: {
          manualChunks(id: string) {
            if (id.includes("quickjs-emscripten") || id.includes("@jitl/")) return "quickjs";
            if (id.includes("memfs")) return "memfs";
            if (id.includes("@bolojs/npm") || id.includes("@unjs/lockfile")) return "npm";
          },
        },
      },
    },
  };
}
