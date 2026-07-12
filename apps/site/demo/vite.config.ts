import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { nodeWebShims } from '@browser-containers/node-web-shims/vite-plugin';

const shimsDir = fileURLToPath(new URL('../../../packages/node-web-shims/dist/', import.meta.url));
// unenv's own runtime modules import deep subpaths directly (e.g. `stream.mjs`
// imports `node:stream/promises`) with no dedicated wrapper in node-web-shims;
// resolve straight to unenv's module rather than adding a wrapper per subpath.
// Resolved from node-web-shims' own package scope (via createRequire), not
// apps/site/demo's — apps/site/demo has its own, older unenv (pulled in transitively by
// vite-plugin-node-polyfills) whose `exports` map doesn't have a `./node/*`
// pattern, so a plain `import.meta.resolve` here would resolve the wrong one.
const requireFromNodeWebShims = createRequire(
  fileURLToPath(new URL('../../../packages/node-web-shims/package.json', import.meta.url)),
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
  // Mounted at /demo/ by the Pages gateway; base only affects generated
  // links/asset paths, dist/ stays flat. App.tsx uses import.meta.env.BASE_URL
  // for boot({ swPath }) so the SW resolves to /demo/sw.js under the prefix.
  base: '/demo/',
  plugins: [
    solidPlugin(),
    resolvePolyfillsShim(),
    nodeWebShims(),
    // Polyfill `buffer`, `process`, and `global` so third-party deps (memfs)
    // that import bare Node built-ins work in the browser bundle.
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
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
      // External: these modules are loaded at runtime from CDN (esm.sh/jsdelivr).
      // Using external (not @vite-ignore) ensures Rollup NEVER bundles them.
      // @vite-ignore only suppresses warnings — it does NOT prevent bundling.
      external: [
        'typescript',     // wasm-registry tsc tool + vite-server
        'oxc-transform',  // wasm-registry oxc-transform tool + vite-server
        '@rolldown/browser', // wasm-registry rolldown/browser bundler
        'sass',           // wasm-registry sass tool
        '@swc/wasm-web',  // wasm-registry swc tool (WASM binary loaded via CDN)
      ],
      output: {
        // Function form — only splits modules that actually appear in the bundle,
        // avoiding "Could not resolve entry module" for transitive deps.
        manualChunks(id) {
          if (id.includes('quickjs-emscripten') || id.includes('@jitl/')) return 'quickjs';
          if (id.includes('memfs')) return 'memfs';
          if (id.includes('@browser-containers/npm') || id.includes('@unjs/lockfile')) return 'npm';
        },
      },
    },
  },
  // Vite's dep-pre-bundle step resolves imports through `resolve.alias`
  // (its own resolver plugin), not through `optimizeDeps.esbuildOptions.alias`
  // (a raw esbuild build option esbuild only consults when no plugin claims
  // the import first — and Vite's own dep-prebundle resolver always claims
  // node:* specifiers first). So third-party deps pre-bundled by esbuild
  // (e.g. memfs, whose `node:events`-derived `EventEmitter` subclass would
  // otherwise crash against Vite's default browser-external stub) need the
  // shim aliased here, same as `nodeWebShims()` does for the dev-server's own
  // module graph.
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
  // can emit the worker as a separate chunk rather than inlining it.
  optimizeDeps: {
    exclude: ['@browser-containers/runtime'],
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
