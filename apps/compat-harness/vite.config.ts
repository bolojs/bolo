import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { nodeWebShims } from '@browser-containers/node-web-shims/vite-plugin';

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
      return requireFromApp.resolve(source);
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
  build: {
    target: 'esnext',
    rollupOptions: {
      external: [
        'typescript',     // wasm-registry tsc tool + vite-server
        'oxc-transform',  // wasm-registry oxc-transform tool + vite-server
        '@rolldown/browser', // wasm-registry rolldown/browser bundler
        'sass',           // wasm-registry sass tool
        '@swc/wasm-web',  // wasm-registry swc tool (WASM binary loaded via CDN)
      ],
    },
  },
  resolve: {
    alias: [
      { find: 'node:stream/promises', replacement: streamPromisesShim },
      { find: /^node:events$/, replacement: `${shimsDir}events.js` },
      { find: /^node:net$/, replacement: requireFromNodeWebShims.resolve('unenv/node/net') },
      { find: /^node:path$/, replacement: `${shimsDir}path.js` },
      { find: /^node:stream$/, replacement: `${shimsDir}stream.js` },
      { find: /^node:async_hooks$/, replacement: `${shimsDir}async_hooks.js` },
    ],
  },
  // RuntimeWorker uses `new Worker(new URL('./worker-script.ts', import.meta.url), …)`.
  // Excluding the package from pre-bundling keeps that URL pattern intact so Vite
  // can emit the worker as a separate chunk rather than inlining it.
  optimizeDeps: {
    exclude: ['@browser-containers/runtime'],
  },
});
