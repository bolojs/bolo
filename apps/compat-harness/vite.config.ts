import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { nodeWebShims } from '@bolojs/node-web-shims/vite-plugin';

const shimsDir = fileURLToPath(new URL('../../packages/node-web-shims/dist/', import.meta.url));
// Same rationale as apps/demo/vite.config.ts: unenv's own runtime modules
// import deep subpaths directly (e.g. `stream.mjs` imports
// `node:stream/promises`) with no dedicated wrapper in node-web-shims, so
// resolve straight to unenv's module — from node-web-shims' own package
// scope, not this app's, since this app has no direct unenv dependency.
const requireFromNodeWebShims = createRequire(
  fileURLToPath(new URL('../../packages/node-web-shims/package.json', import.meta.url)),
);
const streamPromisesShim = requireFromNodeWebShims.resolve('unenv/node/stream/promises');

const requireFromApp = createRequire(import.meta.url);
// vite-plugin-node-polyfills@0.28.0 injects internal imports
// (`vite-plugin-node-polyfills/shims/buffer` etc.) that Rollup's commonjs
// plugin under Vite 6 can't resolve (tries to open the path as a literal file).
// Pre-resolve them via a plugin hook that runs before commonjs.
const resolvePolyfillsShim = (): Plugin => ({
  name: 'resolve-polyfills-shims',
  enforce: 'pre',
  resolveId(source: string) {
    if (source.startsWith('vite-plugin-node-polyfills/shims/')) {
      const resolved = requireFromApp.resolve(source);
      // Prefer ESM (.js) over CJS (.cjs) — Vite 6's CJS interop misses
      // `exports.default` in these shims due to their __esModule marker.
      const esm = resolved.replace(/\.cjs$/, '.js');
      return existsSync(esm) ? esm : resolved;
    }
    return null;
  },
});

export default defineConfig({
  plugins: [
    resolvePolyfillsShim(),
    nodeWebShims(),
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  // packages/runtime's worker-script.ts uses top-level await
  // (`await configureBrowserLogging()`). Vite's default worker format is
  // IIFE which can't host TLA — emit ES workers instead so Rollup keeps it.
  // ponytail: top-level Vite config in v8, not nested under `build`.
  worker: { format: 'es' },
  // rolldown/browser's WASI+threads binary needs SharedArrayBuffer, which
  // requires cross-origin isolation — without these headers it traps with
  // a bare "unreachable" WASM RuntimeError on every bundleEntry() call.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      external: [
        'typescript',     // wasm-registry tsc tool + vite-server
        // rolldown/oxc are loaded locally in dev (see src/main.ts), but the
        // production `vite build` (unused by the actual refresh pipeline,
        // which only runs the dev server) still can't resolve oxc-transform's
        // browser.js — it references @oxc-transform/binding-wasm32-wasi, a
        // platform binding that's never installed. Keep both external here;
        // this option only affects `vite build`, not the dev server.
        'oxc-transform',  // wasm-registry oxc-transform tool
        '@rolldown/browser', // wasm-registry rolldown/browser bundler
        'sass',           // wasm-registry sass tool
        '@swc/wasm-web',  // wasm-registry swc tool (WASM binary loaded via CDN)
      ],
    },
  },
  resolve: {
    alias: [
      // Object-form alias keys match by prefix (`node:stream` would also
      // rewrite `node:stream/promises`), so use exact-match RegExps and give
      // the one subpath actually imported (`node:stream/promises`) its own,
      // more specific entry ahead of it.
      { find: 'node:stream/promises', replacement: streamPromisesShim },
      { find: /^node:events$/, replacement: `${shimsDir}events.js` },
      { find: /^node:net$/, replacement: requireFromNodeWebShims.resolve('unenv/node/net') },
      { find: /^node:path$/, replacement: `${shimsDir}path.js` },
      { find: /^node:stream$/, replacement: `${shimsDir}stream.js` },
      { find: /^node:async_hooks$/, replacement: `${shimsDir}async_hooks.js` },
      // Pre-bundled CJS deps (e.g. @yarnpkg/lockfile) require bare builtins
      // without the node: prefix. Vite's dep optimizer (esbuild) only consults
      // resolve.alias, not plugin resolveId hooks, so alias bare names too.
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
  // RuntimeWorker uses `new Worker(new URL('./worker-script.ts', import.meta.url), …)`.
  // Excluding the package from pre-bundling keeps that URL pattern intact so Vite
  // can emit the worker as a separate chunk rather than inlining it. Same applies
  // to @rolldown/browser's own wasi-worker-browser.mjs and oxc-transform's wasm
  // loader — both are now served locally (see src/main.ts's __preferLocalBundler),
  // so pre-bundling them would break their internal `import.meta.url`-relative
  // asset/worker URLs.
  optimizeDeps: {
    exclude: [
      '@bolojs/runtime',
      'oxc-transform',
      '@rolldown/browser',
      'typescript',
      'sass',
      '@swc/wasm-web',
    ],
    esbuildOptions: {
      plugins: [
        {
          name: 'resolve-bare-builtins',
          setup(build) {
            const bare = ['crypto', 'events', 'path', 'stream', 'util', 'assert', 'os', 'tty'];
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
});
