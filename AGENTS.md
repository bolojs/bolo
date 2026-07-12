# PROJECT KNOWLEDGE BASE

## OVERVIEW

Browser-based Node.js runtime monorepo. Open-source, fully client-side. Run Node.js applications, AI agent code, and build tools entirely in the browser with zero server dependency.

## PROJECT MANAGEMENT

GitHub Project: https://github.com/orgs/browser-containers/projects/1 — all work must link to a refined task here (see global backlog policy).

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
  npm/               Browser-native package installer (registry resolve + tarball extract)
  vite-server/       BrowserViteServer — Vite dev server on main thread
apps/
  site/              browser-containers.pages.dev (one product on one domain)
    landing/         @browser-containers/site-landing    Astro/Starlight, mounted at "/" by router
    compat/          @browser-containers/site-compat     Astro heat-grid,     mounted at "/compat"
    demo/            @browser-containers/site-demo       Vite/Solid,          mounted at "/demo"
    router/          @browser-containers/site-router     Pages Functions gateway (Service Bindings)
  compat-harness/    Nightly npm-package matrix harness (data source for /compat)
tests/
  unit/              Vitest, no browser
  integration/       Vitest + happy-dom
  e2e/               Gauge + agent-browser specs. Use 'dev-browser', 'dogfood' skills/tools
```

## Documentation Map

- **This file** — project overview and conventions
- **PRD, ADRs, contributing guide (internal)** — [`.agents/docs/`](.agents/docs/). Browse locally with `pnpm docs:internal`. PRD: `.agents/docs/prd.md`. ADRs: `.agents/docs/adr/0001-...md`, ...0006. Shim contributing: `.agents/docs/contributing-shims.md`.
- **End-user docs (public)** — deployed Starlight, source [`apps/site/landing/src/content/docs/docs/`](apps/site/landing/src/content/docs/docs/). Live URL pattern `https://browser-containers.pages.dev/docs/<slug>/`. Slugs: `getting-started`, `api`, `alternatives`, `migration`, `compat`, `shim-coverage`, `package-managers`, `wasm-registry`, `index`.
- **Implementation plan** — `.agents/plans/<date>-<purpose>.md` (ephemeral working plans)

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
| Package install | `packages/npm` | Browser-native installer + esm.sh fallback |
| Vite dev server | `packages/vite-server` | Main thread, HMR via BroadcastChannel |
| Demo app | `apps/site/demo` | IDE-like UI wiring all packages together, mounted at `/demo` |

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

### Git Worktrees

All git worktrees **must** be created under `./.worktrees/` (relative to the repo root). Never create worktrees in the repo root or elsewhere.

```bash
# ✅ Correct
git worktree add .worktrees/feature-name feat/feature-name

# 🚫 Wrong
git worktree add feature-name feat/feature-name
```

#### Worktree-Local Sisyphus State

When running in a worktree, agents **must** use a worktree-local boulder path instead of the project-wide `.sisyphus/boulder.json`. This prevents parallel agents in different worktrees from overwriting each other's state.

```bash
# ✅ Correct — worktree-local state
.worktrees/feature-name/.sisyphus/boulder.json

# ❌ Wrong — project-wide state (shared across all worktrees)
.sisyphus/boulder.json
```

Agents running from the main worktree may use `.sisyphus/boulder.json` as normal.

### Portless (Named Dev URLs)

Dev servers use [portless](https://github.com/vercel-labs/portless) for stable `.localhost` URLs instead of port numbers. First run auto-starts the HTTPS proxy on port 443 and generates a local CA (run `npx portless trust` if you see certificate warnings).

- **Git worktrees**: must live under `./.worktrees/` (see Universal Rules). Each gets a unique subdomain (e.g. `fix-ui.browser-containers.localhost`)
- **Bypass**: set `PORTLESS=0` to run without the proxy (e.g. `PORTLESS=0 bun run dev-web`)
- **Install**: already included as a dev dependency (`npx portless` or via scripts)

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
