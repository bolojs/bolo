# @browser-containers

Open-source, fully client-side Node.js runtime for the browser. Run Node.js applications, AI agent code, and build tools entirely in the browser — no server, no cloud, no installation.

> **Status:** workspace-only — packages are not yet published to npm.
> Clone and build to use. See [docs/getting-started.md](docs/getting-started.md).

## Quick start

```bash
git clone https://github.com/your-org/browser-containers
cd browser-containers
pnpm install && pnpm build
pnpm --filter @browser-containers/demo dev
```

## Packages

| Package | Description |
|---------|-------------|
| [`vfs-bus`](packages/vfs-bus) | Single-owner observable virtual filesystem (memfs + OPFS) |
| [`sw-sandbox`](packages/sw-sandbox) | ServiceWorker-based network proxy for virtual localhost |
| [`node-web-shims`](packages/node-web-shims) | `node:*` → Web API bridges |
| [`node-runtime-shims`](packages/node-runtime-shims) | `node:*` → VfsBus/sw-sandbox bridges |
| [`sandbox-policy`](packages/sandbox-policy) | Opt-in AI agent sandboxing |
| [`wasm-registry`](packages/wasm-registry) | Native binary → WASM dispatcher (esbuild, tsc, sass, swc) |
| [`runtime`](packages/runtime) | Core container API (V8 + QuickJS tiers) |
| [`npm`](packages/npm) | Package installation in the browser |
| [`vite-server`](packages/vite-server) | Vite dev server on main thread |

## vs. alternatives

| | browser-containers | WebContainers | Nodebox |
|---|---|---|---|
| License | Apache 2.0 | Proprietary | MIT |
| npm published | No | Yes | Yes |
| AI agent sandbox | **Yes** (QuickJS + C-level caps) | No | No |
| Dual execution tiers | **Yes** (V8 trusted + QuickJS untrusted) | No | No |
| Node.js compat | Partial (shims) | Full | 40+ polyfills |

See [docs/alternatives.md](docs/alternatives.md) for the full comparison.

## Documentation

- [Getting started](docs/getting-started.md) — clone, run, basic API example
- [API reference](docs/api.md) — VfsBus, ShellService, SWSandbox, SandboxPool
- [Alternatives](docs/alternatives.md) — comparison with WebContainers and Nodebox
- [Migration guide](docs/migration.md) — coming from WebContainers or Nodebox
- [PRD](docs/prd.md) — project scope and vision
- [ADR-0001](docs/adr/0001-two-tier-runtime.md) — two-tier runtime architecture
- [ADR-0002](docs/adr/0002-vfs-bus-single-owner.md) — single-owner VFS design
- [ADR-0003](docs/adr/0003-no-webpack-nextjs.md) — no Webpack/Next.js support
- [Shim coverage](docs/shim-coverage.md) — Node.js API shim status
- [WASM registry](docs/wasm-registry.md) — native binary WASM equivalents

## License

Apache 2.0
