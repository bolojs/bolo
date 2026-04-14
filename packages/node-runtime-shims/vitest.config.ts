import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'unenv/runtime/node/crypto': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/crypto/index.mjs',
      ),
      'unenv/runtime/node/stream': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/stream/index.mjs',
      ),
      'unenv/runtime/node/buffer': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/buffer/index.mjs',
      ),
      'unenv/runtime/node/path': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/path/index.mjs',
      ),
      'unenv/runtime/node/url': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/url/index.mjs',
      ),
      'unenv/runtime/node/events': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/events/index.mjs',
      ),
      'unenv/runtime/node/os': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/os/index.mjs',
      ),
      'unenv/runtime/node/http': path.resolve(
        __dirname,
        './node_modules/unenv/runtime/node/http/index.mjs',
      ),
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
