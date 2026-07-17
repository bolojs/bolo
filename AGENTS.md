# PROJECT KNOWLEDGE BASE

## OVERVIEW

Browser-based Node.js runtime monorepo. Open-source, fully client-side. Run Node.js applications, AI agent code, and build tools entirely in the browser with zero server dependency.

## PROJECT MANAGEMENT

GitHub Project: https://github.com/orgs/bolojs/projects/1 — all work must link to a refined task here (see global backlog policy).

## STRUCTURE

```
packages/
  vfs-bus/           Virtual filesystem — single-owner observable VFS (memfs + OPFS)
  sw-sandbox/        ServiceWorker-based network proxy for virtual localhost
  node-web-shims/    node:* → Web API bridges (crypto, stream, buffer, path, url, events, os, http, worker_threads)
  node-runtime-shims/  node:* → VfsBus/sw-sandbox bridges (fs, http createServer, net, child_process)
  wasm-registry/     Bundler (rolldown + oxc-transform, wired in-house) + registerWasmTool() extension seam
  runtime/           Core container API — RuntimeWorker (V8) + IframeSandbox; pluggable SandboxBackend
  npm/               Browser-native package installer (registry resolve + tarball extract)
  vite-server/       BrowserViteServer — Vite dev server on main thread
apps/
  site/              bolojs.pages.dev, one static Pages deploy (build outputs merged, no router)
    landing/         @bolojs/site-landing    Astro/React marketing site, served at "/"
    compat/          @bolojs/site-compat     Astro heat-grid,            served at "/compat"
    demo/            @bolojs/site-demo       Vite/Solid,                 served at "/demo"
    docs/            @bolojs/site-docs       Astro Starlight,            served at "/docs"
  compat-harness/    Nightly npm-package matrix harness (data source for /compat)
tests/
  unit/              Vitest, no browser
  integration/       Vitest + happy-dom
  e2e/               Gauge + Playwright specs. Use `playwright-cli` skill for QA, Gauge for suite work
```

## Documentation Map

- **This file** — project overview and conventions
- **PRD, ADRs, contributing guide (internal)** — [`.agents/docs/`](.agents/docs/). Browse locally with `pnpm docs:internal`. PRD: `.agents/docs/prd.md`. ADRs: `.agents/docs/adr/0001-...md`, ...0006. Shim contributing: `.agents/docs/contributing-shims.md`.
- **End-user docs (public)** — Astro Starlight app, source [`apps/site/docs/src/content/docs/`](apps/site/docs/src/content/docs/). Live URL pattern `https://bolojs.pages.dev/docs/<slug>/`. Slugs: `getting-started`, `api`, `alternatives`, `migration`, `compat`, `shim-coverage`, `package-managers`, `wasm-registry`, `index`.
- **Implementation plan** — `.agents/plans/<date>-<purpose>.md` (ephemeral working plans)

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Virtual filesystem | `packages/vfs-bus` | Single-owner, two-layer (memfs + OPFS), observable events |
| Network proxy | `packages/sw-sandbox` | ServiceWorker intercepts virtual origin, MessageChannel bridge |
| Web API shims | `packages/node-web-shims` | node:* → Web API via unenv, independently usable |
| Runtime shims | `packages/node-runtime-shims` | node:* → VfsBus/SW, depends on vfs-bus + sw-sandbox |
| Bundler / WASM tools | `packages/wasm-registry` | rolldown + oxc-transform (real bundler); `registerWasmTool()` seam for more |
| Container API | `packages/runtime` | RuntimeWorker (V8) + IframeSandbox; pluggable SandboxBackend |
| QuickJS agent sandbox | [bolojs/quickjs-sandbox](https://github.com/bolojs/quickjs-sandbox) | Separate repo; optional SandboxBackend + policy library |
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

- **Git worktrees**: must live under `./.worktrees/` (see Universal Rules). Each gets a unique subdomain (e.g. `fix-ui.bolo.localhost`)
- **Bypass**: set `PORTLESS=0` to run without the proxy (e.g. `PORTLESS=0 bun run dev-web`)
- **Install**: already included as a dev dependency (`npx portless` or via scripts)

## ANTI-PATTERNS

- **NO default exports** in library code
- **NO `composite` or `references`** in tsconfig.json — Turborepo handles build ordering
- **NO `tsc --build`** in root scripts — use `turbo run build`
- **NO Biome** — repo uses oxlint/oxfmt directly
- **NO code from `legacy` branch** — reference only for API shapes
- **NO singleton shim imports** — use factory functions with injected deps

## Agent QA tooling (playwright-cli)

Interactive browser QA uses `playwright-cli` (project-local devDependency, invoked via `pnpm exec playwright-cli`). Same engine as the E2E suite under `tests/e2e/`.

Known gaps vs the previous agent-browser tool, with workarounds:

| Gap | Workaround |
|-----|-----------|
| No `wait-for-element` / `wait --fn` | `eval` + `waitForTimeout` polling, or `eval "await page.waitForSelector(...)"` |
| Snapshot is file-based (2 calls vs 1) | Read the returned YAML path in the next call; acceptable cost |
| No annotated screenshots | Use `show --annotate` for interactive sessions; for CI artifacts rely on the E2E suite's `@CustomScreenshotWriter` |
| No visual diff | Out of scope for QA tool; visual regression belongs in E2E |

Revisit upstream in 2-3 months; if `wait-for-element` lands, drop the documented workarounds.

## Logging (@bolojs/log)

bolo's own internal diagnostics (runtime/sandbox/network/installer/CLI code
describing what *bolo itself* is doing) go through `@bolojs/log`, a thin
wrapper around [logtape](https://logtape.org). This is separate from **guest
passthrough** — the sandboxed user/agent code's own stdout relay
(`worker-script.ts`'s console monkey-patch, `package-runner.ts`'s probe
output) — which stays on plain `console.*` since it's product behavior, not
a bolo diagnostic.

- `getLogger(["bolo", <package>, <module?>])` — Node and browser/worker/SW
  contexts alike (import from `@bolojs/log` in Node, `@bolojs/log/browser`
  elsewhere).
- `configureBoloLogging()` (Node only — CLI, compat-harness, Vitest, the
  Gauge+Playwright driver process) opens `.logs/<run>.jsonl` capturing
  **every** level, symlinked from `.logs/latest.jsonl`, plus a
  `warning`+ pretty console sink. `.logs/` is gitignored.
- Override console verbosity per category: `BOLO_LOG=sandbox=debug,net-shim=trace`.

**Debugging entrypoint for agents**: read `.logs/latest.jsonl` instead of
re-running commands hoping for more console output. It's already full
fidelity.

```bash
# Only errors and fatals
rg '"level":"(error|fatal)"' .logs/latest.jsonl

# Everything from one category branch (e.g. the iframe sandbox)
jq 'select(.category[1]=="runtime" and .category[2]=="iframe-sandbox")' .logs/latest.jsonl
```

A failed Vitest test (`onTestFailed`), Gauge scenario (`AfterScenario`), or
compat-harness `PackageResult` (fail status) all just print/attach this
path — pull the relevant lines in with `rg`/`jq` above rather than re-running
the test for more console output.

## COMMANDS

```bash
pnpm build          # Build all packages via Turborepo
pnpm test           # Run Vitest tests
pnpm lint           # Lint with oxlint via Turborepo
pnpm format         # Check formatting with oxfmt via Turborepo
pnpm typecheck      # Type-check all packages via Turborepo
pnpm clean          # Remove dist/, .turbo/, cache
```
