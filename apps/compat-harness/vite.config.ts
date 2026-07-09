import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [
    nodeWebShims(),
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: { target: 'esnext' },
  resolve: {
    alias: [
      { find: 'node:stream/promises', replacement: streamPromisesShim },
      { find: /^node:events$/, replacement: `${shimsDir}events.js` },
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
