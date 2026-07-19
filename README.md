<p align="center">
  <img src="assets/brand/logo.png" alt="bolo" width="120" height="120" />
</p>

# bolo

Run Node.js, Bun, and Deno apps entirely in the browser, zero server. Runs real npm packages — `npm install` then `npm run dev`, no VM, no rewrite. AI agent code runs sandboxed by default (cross-origin iframe; optional QuickJS backend for hard memory/CPU caps).

**Developer Preview.** [Live demo](https://bolojs-demo.pages.dev) · [Docs](https://bolojs.dev/docs/)

Live demo (app-builder): https://demo.bolojs.dev

## Quick start

```bash
git clone https://github.com/bolojs/bolo
cd bolo
pnpm install && pnpm build
pnpm --filter @bolojs/site-demo dev
```

## Packages

[`vfs-bus`](packages/vfs-bus) · [`sw-sandbox`](packages/sw-sandbox) · [`node-web-shims`](packages/node-web-shims) · [`node-runtime-shims`](packages/node-runtime-shims) · [`wasm-registry`](packages/wasm-registry) · [`runtime`](packages/runtime) · [`npm`](packages/npm) · [`vite-server`](packages/vite-server)

The QuickJS agent sandbox has moved to its own repo: [bolojs/quickjs-sandbox](https://github.com/bolojs/quickjs-sandbox).

## License

Apache 2.0
