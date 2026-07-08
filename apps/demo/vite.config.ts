import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { nodeWebShims } from '@browser-containers/node-web-shims/vite-plugin';

export default defineConfig({
  plugins: [
    solidPlugin(),
    nodeWebShims(),
    // Polyfill `buffer`, `process`, and `global` so third-party deps (memfs,
    // npm-in-browser) that import bare Node built-ins work in the browser bundle.
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: { target: 'esnext' },
  // RuntimeWorker uses `new Worker(new URL('./worker-script.ts', import.meta.url), …)`.
  // Excluding the package from pre-bundling keeps that URL pattern intact so Vite
  // can emit the worker as a separate chunk rather than inlining it.
  optimizeDeps: {
    exclude: ['@browser-containers/runtime'],
    esbuildOptions: {
      alias: {
        'node:events': '@browser-containers/node-web-shims/dist/events.js',
        'node:path': '@browser-containers/node-web-shims/dist/path.js',
        'node:stream': '@browser-containers/node-web-shims/dist/stream.js',
      },
    },
  },
});
