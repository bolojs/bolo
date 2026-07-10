# browser-containers

Run Node.js, Bun, and Deno apps entirely in the browser with zero server dependency. Fully open source (Apache 2.0). Includes a real security sandbox for AI agents (QuickJS + VFS ACLs + CPU/memory caps) so AI coding tools can safely execute untrusted code without escape risk.

> **Try it now:** [Live demo](https://browser-containers-demo.pages.dev)
>
> **Status:** Developer Preview. Works for Node.js apps using Hono, Elysia, itty-router, Vite, and Express. `npm install` then `npm run dev` works in your browser. AI agents run safely in a sandbox.

## Quick start

```bash
git clone https://github.com/browser-containers/browser-containers
cd browser-containers
pnpm install && pnpm build
pnpm --filter @browser-containers/demo dev
```

## Why this exists

WebContainers is proprietary. almostnode and Nodepod are open but have no AI agent sandbox. browser-containers is the first fully client-side Node runtime where AI agents run in real isolation: QuickJS executes untrusted code behind VFS access control lists, memory limits, and CPU operation rate limits.

**Compare:**
| | browser-containers | almostnode | WebContainers | Nodepod |
|---|---:|---:|---:|---:|
| License | Apache 2.0 | MIT | Proprietary | MIT+Commons |
| AI sandbox | **QuickJS + ACL** | iframe (no ACL) | None | None |
| TCP/IP | None (HTTP only) | None | Full | Full |
| Linux kernel | None | None | Full (WASM) | None |
| Persistence | OPFS + memfs | memfs only | OPFS | OPFS snapshots |
| Multi-runtime | Node+Bun+Deno | Node only | Node only | Node only |
| Zero-server | **Yes** | Yes | **No** | **No** |
| npm published | No (workspace) | Yes | Yes | Yes |

## What works

| Use case | Status |
|----------|--------|
| AI agent sandbox (QuickJS + VFS ACL + CPU/memory limits) | Works |
| Hono / Elysia / itty-router (`.fetch` export) | Works |
| Vite dev server (`/__preview/` prefix) | Works |
| Vercel AI SDK | Works (https shim) |
| Express server (`/__virtual__/{port}` routing) | Works |
| Raw `http.createServer` | Works |
| npm install | Works |
| esbuild / tsc / sass / swc (lazy WASM) | Works |

## Known limitations

- No raw TCP/IP sockets (HTTP only via ServiceWorker proxy)
- No Next.js / webpack / turbopack (routing + SSR pipeline missing)
- No native `.node` addons (NAPI, native binaries)
- No `fork()` / `cluster` (multi-process Node.js out of scope)
- No TLS/`https.createServer` (no inbound TLS termination)
- No Vitest (`worker_threads` is a stub, `chokidar` missing)
- ServiceWorker required (HTTPS or localhost only)

## Plugin backends

Some Node.js features need capabilities the browser can't provide natively. Instead of blocking these forever, we expose extension points:

| Feature | Default | Extension point |
|---------|---------|-----------------|
| TCP/IP | HTTP-only (SW proxy) | `netBackend: (deps) => nodeNetNamespace` |
| UDP | Not supported | `dgramBackend: (deps) => { createSocket }` |
| TLS | Not supported | `tlsBackend: (deps) => nodeTlsNamespace` |
| Native .node addons | Not supported | `nativeAddonLoader: (path, vfs) => moduleSync` |
| Worker threads | Stub (`isMainThread=true`) | `workerThreadsBackend: (deps) => workerThreadsNamespace` |

```typescript
import { createLiveShimRegistry } from "@browser-containers/node-runtime-shims";

const registry = createLiveShimRegistry({
  vfs,
  sandbox,
  dgramBackend: ({ vfs }) => ({
    createSocket: (type, onMessage) => new WebTransportDgramSocket(onMessage),
  }),
});
```

## Packages

| Package | Description |
|---------|-------------|
| [`vfs-bus`](packages/vfs-bus) | Single-owner observable virtual filesystem (memfs + OPFS) |
| [`sw-sandbox`](packages/sw-sandbox) | ServiceWorker-based network proxy for virtual localhost |
| [`node-web-shims`](packages/node-web-shims) | `node:*` to Web API bridges |
| [`node-runtime-shims`](packages/node-runtime-shims) | `node:*` to VfsBus/sw-sandbox bridges |
| [`sandbox-policy`](packages/sandbox-policy) | Opt-in AI agent sandboxing |
| [`wasm-registry`](packages/wasm-registry) | Native binary to WASM dispatcher (esbuild, tsc, sass, swc) |
| [`runtime`](packages/runtime) | Core container API (V8 + QuickJS tiers) |
| [`npm`](packages/npm) | Package installation in the browser |
| [`vite-server`](packages/vite-server) | Vite dev server on main thread |

## Documentation

- [Getting started](docs/getting-started.md)
- [API reference](docs/api.md)
- [Alternatives](docs/alternatives.md)
- [PRD](docs/prd.md)
- [ADR-0001](docs/adr/0001-two-tier-runtime.md) - two-tier runtime architecture
- [ADR-0002](docs/adr/0002-vfs-bus-single-owner.md) - single-owner VFS design
- [ADR-0003](docs/adr/0003-no-webpack-nextjs.md) - no Webpack/Next.js support
- [Shim coverage](docs/shim-coverage.md)
- [WASM registry](docs/wasm-registry.md)

## License

Apache 2.0
