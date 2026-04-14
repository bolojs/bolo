# @browser-containers

Open-source, fully client-side Node.js runtime for the browser. Run Node.js applications, AI agent code, and build tools entirely in the browser — no server, no cloud, no installation.

## Packages

| Package | Description |
|---------|-------------|
| [`vfs-bus`](packages/vfs-bus) | Single-owner observable virtual filesystem (memfs + OPFS) |
| [`sw-sandbox`](packages/sw-sandbox) | ServiceWorker-based network proxy for virtual localhost |
| [`node-web-shims`](packages/node-web-shims) | `node:*` → Web API bridges |
| [`node-runtime-shims`](packages/node-runtime-shims) | `node:*` → VfsBus/sw-sandbox bridges |
| [`sandbox-policy`](packages/sandbox-policy) | Opt-in AI agent sandboxing |
| [`wasm-registry`](packages/wasm-registry) | Native binary → WASM dispatcher |
| [`runtime`](packages/runtime) | Core container API (V8 + QuickJS tiers) |
| [`npm`](packages/npm) | Package installation in the browser |
| [`vite-server`](packages/vite-server) | Vite dev server on main thread |

## Quick Start

```bash
pnpm install
pnpm build
```

## Documentation

- [PRD](docs/prd.md) — project scope and vision
- [ADR-0001](docs/adr/0001-two-tier-runtime.md) — two-tier runtime architecture
- [ADR-0002](docs/adr/0002-vfs-bus-single-owner.md) — single-owner VFS design
- [ADR-0003](docs/adr/0003-no-webpack-nextjs.md) — no Webpack/Next.js support
- [Shim Coverage](docs/shim-coverage.md) — Node.js API shim status
- [WASM Registry](docs/wasm-registry.md) — native binary WASM equivalents

## Legacy Branch

The `legacy` branch contains a previous implementation and exists for API reference only. No code is ported from `legacy` into this monorepo.

## License

Apache 2.0
