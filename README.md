# browser-containers

Run Node.js, Bun, and Deno apps entirely in the browser, zero server. Runs real npm packages — `npm install` then `npm run dev`, no VM, no rewrite. AI agent code runs sandboxed by default (cross-origin iframe; optional QuickJS backend for hard memory/CPU caps).

**Developer Preview.** [Live demo](https://browser-containers-demo.pages.dev) · [Docs](https://browser-containers.pages.dev/docs/)

## Quick start

```bash
git clone https://github.com/browser-containers/browser-containers
cd browser-containers
pnpm install && pnpm build
pnpm --filter @browser-containers/site-demo dev
```

## Packages

[`vfs-bus`](packages/vfs-bus) · [`sw-sandbox`](packages/sw-sandbox) · [`node-web-shims`](packages/node-web-shims) · [`node-runtime-shims`](packages/node-runtime-shims) · [`wasm-registry`](packages/wasm-registry) · [`runtime`](packages/runtime) · [`npm`](packages/npm) · [`vite-server`](packages/vite-server)

The QuickJS agent sandbox has moved to its own repo: [browser-containers/quickjs-sandbox](https://github.com/browser-containers/quickjs-sandbox).

## License

Apache 2.0
