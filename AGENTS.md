# PROJECT KNOWLEDGE BASE

## OVERVIEW

Browser-based Node.js runtime monorepo. Open-source, fully client-side. Run Node.js applications, AI agent code, and build tools entirely in the browser with zero server dependency.

## STRUCTURE

```
packages/
  vfs-bus/           Virtual filesystem — single-owner observable VFS (memfs + OPFS)
  sw-sandbox/        ServiceWorker-based network proxy for virtual localhost
  node-web-shims/    node:* → Web API bridges (crypto, stream, buffer, path, url, events, os, http, worker_threads)
  node-runtime-shims/  node:* → VfsBus/sw-sandbox bridges (fs, http createServer, net, child_process)
  sandbox-policy/    Opt-in AI agent sandboxing (network, memory, CPU, filesystem caps)
  wasm-registry/     Native binary → WASM dispatcher (esbuild, tsc, sass, swc)
  runtime/           Core container API — RuntimeWorker (V8) + SandboxPool (QuickJS)
  npm/               Package installation via npm-in-browser + esm.sh CDN fallback
  vite-server/       BrowserViteServer — Vite dev server on main thread
apps/
  demo/              IDE-like demo app
tests/
  unit/              Vitest, no browser
  integration/       Vitest + happy-dom
  e2e/               Gauge + agent-browser specs
```

## Documentation Map

- **This file** — project overview and conventions
- **PRD** — [`docs/prd.md`](docs/prd.md)
- **Architecture decisions** — [`docs/adr/0001-two-tier-runtime.md`](docs/adr/0001-two-tier-runtime.md) · [`docs/adr/0002-vfs-bus-single-owner.md`](docs/adr/0002-vfs-bus-single-owner.md) · [`docs/adr/0003-no-webpack-nextjs.md`](docs/adr/0003-no-webpack-nextjs.md)
- **Implementation plan** — `tmp/plan.md` (ephemeral)
- **Shim coverage** — [`docs/shim-coverage.md`](docs/shim-coverage.md)
- **WASM registry** — [`docs/wasm-registry.md`](docs/wasm-registry.md)

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Virtual filesystem | `packages/vfs-bus` | Single-owner, two-layer (memfs + OPFS), observable events |
| Network proxy | `packages/sw-sandbox` | ServiceWorker intercepts virtual origin, MessageChannel bridge |
| Web API shims | `packages/node-web-shims` | node:* → Web API via unenv, independently usable |
| Runtime shims | `packages/node-runtime-shims` | node:* → VfsBus/SW, depends on vfs-bus + sw-sandbox |
| Sandbox policy | `packages/sandbox-policy` | Opt-in, zero overhead when unused |
| WASM tools | `packages/wasm-registry` | Lazy-loaded native binary → WASM dispatcher |
| Container API | `packages/runtime` | RuntimeWorker (V8) + SandboxPool (QuickJS) |
| Package install | `packages/npm` | npm-in-browser + esm.sh fallback |
| Vite dev server | `packages/vite-server` | Main thread, HMR via BroadcastChannel |
| Demo app | `apps/demo` | IDE-like UI wiring all packages together |

## CONVENTIONS

- TypeScript strict mode, ES2022, ESNext modules, bundler resolution
- Named exports only (no default exports in library code)
- Arrow functions preferred
- Interfaces for object shapes, type aliases for unions
- Shim factory pattern — deps injected, never singleton imports
- pnpm workspaces (`workspace:*` protocol)
- Turborepo task orchestration (build, test, lint, format, typecheck)
- oxlint + oxfmt for linting and formatting
- Vitest for testing

## ANTI-PATTERNS

- **NO default exports** in library code
- **NO `composite` or `references`** in tsconfig.json — Turborepo handles build ordering
- **NO `tsc --build`** in root scripts — use `turbo run build`
- **NO Biome** — repo uses oxlint/oxfmt directly
- **NO code from `legacy` branch** — reference only for API shapes
- **NO singleton shim imports** — use factory functions with injected deps

## COMMANDS

```bash
pnpm build          # Build all packages via Turborepo
pnpm test           # Run Vitest tests
pnpm lint           # Lint with oxlint via Turborepo
pnpm format         # Check formatting with oxfmt via Turborepo
pnpm typecheck      # Type-check all packages via Turborepo
pnpm clean          # Remove dist/, .turbo/, cache
```
