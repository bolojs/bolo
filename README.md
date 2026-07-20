<p align="center">
  <img src="assets/brand/logo.png" alt="bolo" width="120" height="120" />
</p>

# bolo

Run Node.js, Bun, and Deno apps entirely in the browser, zero server. Runs real npm packages: `npm install` then `npm run dev`, no VM, no rewrite. AI agent code runs sandboxed by default (cross-origin iframe; optional QuickJS backend for hard memory/CPU caps).

**Developer Preview.** [Live demo](https://demo.bolojs.dev) · [Docs](https://bolojs.dev/docs/) ·
[Docs for agents](https://bolojs.dev/docs/llms.txt)

## Quick start

```bash
git clone https://github.com/bolojs/bolo
cd bolo
pnpm install && pnpm build
pnpm --filter @bolojs/example-app-builder dev
```

## Packages

| Package | What it does |
|---|---|
| [`bolojs`](packages/runtime) | Core container API, `boot()` |
| [`@bolojs/fs`](packages/vfs-bus) | Virtual filesystem (memfs + OPFS) |
| [`@bolojs/pm`](packages/npm) | Browser-native npm installer |
| [`@bolojs/registry`](packages/wasm-registry) | In-browser bundler (rolldown + oxc-transform) |
| [`@bolojs/sandbox`](packages/sw-sandbox) | ServiceWorker network proxy |
| [`@bolojs/node-web-shims`](packages/node-web-shims) | `node:*` to Web API shims |
| [`@bolojs/node-runtime-shims`](packages/node-runtime-shims) | `node:*` to VFS/sandbox bridges |
| [`@bolojs/vite-server`](packages/vite-server) | Vite dev server inside a container |
| [`@bolojs/vite-preset`](packages/vite-preset) | Vite preset for apps embedding bolo |
| [`@bolojs/log`](packages/log) | Internal diagnostics |

The QuickJS agent sandbox has moved to its own repo: [bolojs/quickjs-sandbox](https://github.com/bolojs/quickjs-sandbox).

## License

Apache 2.0
