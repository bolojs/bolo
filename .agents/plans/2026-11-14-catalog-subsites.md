# Catalog subsites architecture plan

Date: 2026-11-14. Status: plan only, no feature code. Builds on PR #173 (`docs/catalog-plan` is based on `origin/main`, which does not yet contain the Catalog route; PR #173 adds `apps/site/landing/src/pages/catalog.astro` and the navbar link).

## 1. Goal and context

The landing site gains four subsites behind the existing Catalog cards (`/ide`, `/sandbox`, `/app`, `/vibe`).

All four run entirely client-side on bolo's existing stack: `@bolojs/runtime` (container: `boot()`, `RuntimeWorker`, `spawn`, REPL, `server-ready` event), `@bolojs/fs` (VfsBus, memfs + OPFS), `@bolojs/sandbox` (ServiceWorker virtual origin, `SWSandbox.create({origin, swPath})`, scope derived from `swPath`), `@bolojs/pm` (browser-native installer + lockfile replay + esm.sh fallback), `@bolojs/registry` (rolldown + oxc-transform WASM, `registerWasmTool()` seam), `@bolojs/vite-server` (in-browser Vite-semantics dev server), node shims (`@bolojs/node-web-shims`, `@bolojs/node-runtime-shims`).

## 2. What exists today and the gaps

Evidence from the repo (paths on `origin/main`).

### A. Shared capabilities

- Container API is solid for these use cases: `packages/runtime/src/container.ts` gives `fs`, `mount`, `spawn` (streamed output + exit), `startRepl/evalRepl` with continuation support, checkpoint/resume, `on("server-ready")`. Gaps: `boot()` is a process-global singleton (one container per page), `IframeSandbox` backend is a toy (1 MB cap, eval only), and `SandboxBackend.run()` has no streaming, timeout, or policy hooks.
- VFS: `packages/vfs-bus/src/vfs-bus.ts` has watch handlers, snapshot/restore, OPFS persistence. Gap: single-owner, so one VfsBus per project, and the IDE must wire editor writes to VFS watch to drive rebuilds (the landing demo only syncs on terminal submit, `Demo.tsx:181`).
- Network: `packages/sw-sandbox` gives a virtual origin plus a sync-XHR bridge; node `http.createServer` works via `createHttpShim`. No landing scenario actually serves HTTP today (both demo scenarios are `servesHttp: false`), so the preview path needs its first real product wiring.
- Package install works browser-natively with esm.sh fallback; native modules are detected and rejected (`detectNativeBuild`).
- Bundler/transform: WASM oxc-transform and rolldown, forced single-threaded (`patchWasiAsyncPool` in `packages/vite-preset`), so large apps transform slowly.

### B. Per-use-case gaps

- `/ide`: no multi-file editor, no file tree, no resizable panes (landing demo is fixed flex, `Demo.tsx` layout). `BrowserViteServer` (`packages/vite-server/src/browser-vite-server.ts`) is transpile + importmap + full-reload only; no plugin pipeline, no Tailwind/PostCSS, no SSR, no Fast Refresh. Editor edits do not auto-sync to the VFS. Next.js support: zero (see below).
- `/sandbox`: REPL exists and works; needs terminal-first UX, better process control (interrupt, timeouts), and a real backend story (QuickJS backend with resource caps lives in the external `bolojs/quickjs-sandbox` repo; `IframeSandbox` is not product grade).
- `/app`: the pieces exist (http shim server, SW virtual origin) but nothing demos frontend + backend end-to-end. The reference sibling dits is NOT an in-browser app: it is Bun + Hono + SQLite, one binary serving SPA and API. What we borrow from dits is the contract-first shape: routes mounted under a versioned prefix, valibot-shared schemas consumed by both sides, one `fetch` client module. Swap `bun:sqlite` for VfsBus persistence.
- `/vibe`: `examples/app-builder` already proves the loop end-to-end: OpenRouter BYOK via `@openrouter/ai-sdk-provider` + `ai` v7 `streamText`, tools `writeFile/readFile/deleteFile/listFiles/runCommand` in `src/container/tools.ts`, two-phase plan/build orchestration in `src/ai/useBuilderChat.ts`, OPFS persistence of VFS snapshots. It has no automated tests and a hand-copied SW.

## 3. Vite and Next.js plan

### Vite (current state, honest)

`BrowserViteServer` is not Vite. It serves static HTML, transpiles TS/TSX/JSX via oxc-transform, resolves extensionless imports, injects an importmap written by npm install, and broadcasts `full-reload` over BroadcastChannel. E2E specs `tests/e2e/specs/v0.1.0-react-vite.spec` and `v0.2.0-react-vite.spec` (both tagged `wip`) show a stock Vite+React template gets: install, TSX transform, `npm run dev`, preview shows "Hello from React", full-reload on file write. Notably the "transforms TSX" step is an empty stub and HMR is faked by manually posting to BroadcastChannel in the test.

Vite milestone plan for `/ide`:

- M1 (exists): transpile + importmap + full-reload. Harden it: fix the e2e stubs, wire real VfsBus watch -> `broadcastHmr`, pass through the subsite.
- M2: dependency pre-bundling via `@bolojs/registry` `bundleEntry` so bare imports stop depending on the importmap alone and esm.sh fallback becomes last resort.
- M3: scoped CSS/Tailwind post-processing in the container (oxc-level transforms plus a minimal PostCSS subset). Fast Refresh is explicitly out of scope; full-reload is acceptable for a first cut.

### Next.js (feasibility verdict)

Research summary:

- StackBlitz WebContainers run the real `next dev` client-side because they ship a WASM Node micro-OS; bolt.new and bolt.diy inherit that. Not an option here: proprietary runtime, and bolo's architecture is shim-and-worker based.
- Sandpack supports Next via its own runtime emulation, not stock `next`.
- almostnode (`macaly/almostnode`, MIT, ~250 KB) is the proof point for our architecture: hand-built `ViteDevServer` and `NextDevServer` in the main thread or a worker, Pages Router AND App Router, API routes, CSS modules, React Refresh via postMessage HMR, served through a SW at a virtual prefix.
- `@next/swc-wasm-web` exists, tracks Next 16, exposes SWC `transform/minify/parse` in WASM but NOT the Turbopack `Project` API.
- Turbopack client-side is infeasible (napi-only project API). Native `@next/swc` binaries, sharp, and native SWC plugins are infeasible. Stock `next dev` as-is is infeasible (TCP bind, worker spawn, napi).

Recommended architecture: a new package `packages/next-server` (published as `@bolojs/next-server`), modeled on `BrowserViteServer`, NOT running the `next` CLI. Files:

- `src/next-dev-server.ts`: `NextDevServer` with `start()`, `onFetch(url, request) -> Response | null`, `handleHmr()`. Mounted by the runtime at `/__next/` like vite-server is at `/__preview/` (`packages/runtime/src/runtime-builder.ts:69-70`).
- `src/route-manifest.ts`: scan `pages/` (then `app/`) in VfsBus, build the route table (dynamic segments, catch-alls).
- `src/compile.ts`: SWC-wasm wrapper around `@next/swc-wasm-web` for page transforms (JSX, styled-jsx, Next babel-pass equivalents the wasm build exposes); fall back to oxc-transform for files SWC-wasm rejects.
- `src/document.ts`: compile `_document.tsx`/`_app.tsx`, assemble the HTML shell server-side in the worker (server components are NOT needed for Pages Router).
- `src/data.ts`: run `getServerSideProps`/`getStaticProps` inside the RuntimeWorker by importing the compiled page module there; API routes likewise (maps onto the existing `onFetch` + http-shim path).
- `src/hmr.ts`: full-reload over the existing BroadcastChannel convention (`{type:"full-reload"}`); Fast Refresh is a stretch goal.

Milestones:

- N1 (first cut, target of this plan): Pages Router only. Filesystem routes, `_app`/`_document`, client-side data fetching (`getStaticProps` at build-of-request time), API routes, full-reload HMR. Create-next-app Pages template runs.
- N2: `getServerSideProps` per-request execution, CSS modules, image-component stub (render plain img, warn).
- N3 (stretch): App Router (RSC payload encoding, streaming). Flag honestly as a research spike first; do not commit to a date.

Risks: `@next/swc-wasm-web` ABI drift with Next versions (pin one Next major); wasm SWC transform surface may not cover all Next babel passes (fallback to oxc, degraded output); bundle size of the wasm (~20 MB uncompressed) hits first-boot cost on Pages; repo docs currently declare Webpack/Next out of scope (`docs/alternatives.md:76`), so N1 implies a docs edit.

## 4. Site structure decision (one structure)

Recommendation: build all four subsites as routes inside the existing `apps/site/landing` Astro app, not as new Astro apps.

Rationale:

- The merged Pages deploy (`apps/site/_redirects`, `.github/workflows/deploy.yml` assembling landing/dist + compat/dist + docs/dist) already works; adding routes to landing adds zero CI surface.
- ServiceWorker scoping is the hard constraint. `landing/public/sw.js` occupies the root scope `/` and calls `clients.claim()`. New per-subsite SWs must live at `apps/site/landing/public/<name>/sw.js` giving scope `/<name>/`; longest-scope matching means the subsite SW wins for its subtree and coexists with the root SW. Four separate Astro apps merged at subpaths would force each to reason about this at a distance from the container boot code that consumes it.
- `boot()` is a page-global singleton; each subsite page owns exactly one container lifetime, which matches the one-page-one-subsite UX.
- Shared deps (CodeMirror 6, xterm 6, Solid) stay in one package.json instead of being duplicated across four.
- The counterargument (landing app bloat) is handled by keeping subsite code in `src/subsites/<name>/` with strict per-subsite folders, so extraction to separate apps later is mechanical.

Layout: add `src/layouts/SubsiteLayout.astro` (shared shell WP) that renders the shared Navbar with links Catalog + the four routes, plus a shared boot helper `src/subsites/shared/boot.ts` wrapping `boot({swPath: "/<name>/sw.js", ...})` with teardown on pagehide.

Headers: `apps/site/_headers` already sends COOP `same-origin` + COEP `credentialless` for `/*`; new subsite routes inherit it, no change needed. CSP is not set anywhere; adding one is out of scope but noted as follow-up.

## 5. UI approach per subsite

Reuse, do not introduce Monaco or new design deps.

- Shared panels (new `src/subsites/ui/`, Solid): `FileTree` (built on VfsBus `readdir` + watch), `Editor` (extend landing's CodeMirror 6 setup to multi-document with tabs; keep the custom CSS-var theme), `Terminal` (reuse landing's xterm wrapper, extract it from the demo into shared UI), `Preview` (plain iframe on the `server-ready` URL), `SplitPane` (new, dependency-light pointer-event splitter; the demo has none).
- `/ide`: three-column workbench: file tree + editor | preview, terminal drawer. Vite+React starter template files; Next template files once `packages/next-server` lands.
- `/sandbox`: justbash.dev style: full-height terminal, tab bar for REPL vs script output, chip row of example commands, minimal chrome.
- `/app`: Data Studio/Postman style: left panel = backend route editor (method, path, handler code in CodeMirror), right panel = request builder (method, URL, headers, body) + response viewer (status, headers, formatted JSON). Persistence in OPFS via VfsBus snapshots.
- `/vibe`: bolt.diy style: left chat column (streaming, tool receipts), right preview + terminal; config dialog for provider/model/key, ported from `examples/app-builder/src/ui/ConfigDialog.tsx`.
- Design alignment: all subsites import `apps/site/shared/tokens.css` (Tailwind v4 tokens over `--bg/--fg/--muted/--border`, Geist fonts) exactly like landing's `global.css` does; subsite-specific accent vars land on top, following the landing demo pattern. No new fonts, no new icon set (keep phosphor-icons-astro).

## 6. LLM access for `/vibe`

BYO key, client-side only, same as app-builder: OpenRouter via `@openrouter/ai-sdk-provider` + `ai` v7, key in localStorage, model list from `/api/v1/models`, key never touches bolo infrastructure. Provider abstraction in `src/subsites/vibe/ai/providers.ts` keeps Anthropic/OpenAI-shaped additions one file away. Tools (`src/subsites/vibe/ai/tools.ts`, port of app-builder's): `writeFile`, `readFile`, `deleteFile`, `listFiles`, `runCommand` with 5 s timeout reporting "still running" so dev servers survive. Safety: no eval of model output outside the container; `runCommand` is allowlisted to node/npm/npx/git plus a denylist (no rm -rf /, no network exfil beyond what the SW already allows); chat sends file contents of the project only, system prompt instructs the model to avoid requesting secrets; export/delete-project buttons are explicit; a visible banner states the key stays in the browser.

## 7. Testing and verification

Follow `tests/AGENTS.md`: unit = Vitest, integration = Vitest + happy-dom, e2e = Gauge + Playwright, black-box, observability harness (page console, pageerror, requestfailed, SW lifecycle; ref `examples/app-builder/scripts/pw-observe.js`) installed before any debugging.

- `packages/next-server`: unit tests for route-manifest parsing and document assembly (pure, fast); happy-dom integration for `onFetch` routing against a MemoryBackend VFS.
- Each subsite: one Gauge spec under `tests/e2e/specs/<name>.spec` with steps asserting boot, the headline interaction (run Vite project, REPL eval, API roundtrip, chat -> file written -> preview updated), and network isolation. Reuse `specs/v1.0-boot-api.spec` step style (inline JSON file trees).
- Definition of done per WP: its spec passes locally plus `pnpm typecheck` and `pnpm lint` green for touched packages.

## 8. Work breakdown (5+1 WPs, all independent after WP1)

WP0 does not exist (Catalog route ships in PR #173).

WP1: Shared subsite shell and IDE core panels. Owns: `apps/site/landing/src/layouts/SubsiteLayout.astro`, `src/subsites/shared/{boot.ts,sw-handlers.ts}`, `src/subsites/ui/{FileTree,Editor,Terminal,Preview,SplitPane}.tsx` (extracted/extended from `src/demo/*`), per-subsite SW scripts `public/{ide,sandbox,app,vibe}/sw.js` built from `packages/sw-sandbox` protocol (fixing the hand-copied SW debt noted in app-builder's README), navbar link updates in shared Navbar usage. Acceptance: a stub page per route renders shell + panels with a booted container; one Gauge smoke spec boots each route without SW errors. Dependencies: none. Size: ~24 h.

WP2: `/ide` with Vite template. Owns: `src/subsites/ide/**`, vite scenario templates (Vite+React starter), wiring VfsBus watch to `BrowserViteServer.broadcastHmr`, real e2e for the vite-server specs (un-stub `browser-steps.ts` transform/HMR steps). Acceptance: `tests/e2e/specs/ide.spec` runs a Vite+React project end-to-end; the two existing `wip` vite specs pass untagged. Dependencies: WP1. Size: ~16 h.

WP3: Next.js support package `packages/next-server`. Owns: the new package per section 3 (N1 scope only: Pages Router, `_app`/`_document`, API routes, full-reload HMR), plus a docs edit to `docs/alternatives.md` revising the out-of-scope line and a `/ide` Next template. Acceptance: N1 unit + integration tests green; Gauge spec `nextjs.spec` boots a create-next-app Pages tree and shows a page plus a working API route. Dependencies: WP1 (may start in parallel with WP2; its /ide template integration depends on WP2). Size: ~40 h.

WP4: `/sandbox`. Owns: `src/subsites/sandbox/**` (terminal-first UI, REPL + script runner + npm install flows, example chips). Optional backend swap to QuickJS from `bolojs/quickjs-sandbox` behind the SandboxBackend interface. Acceptance: `sandbox.spec` runs a script, a REPL continuation, and an npm install, all terminal-observable. Dependencies: WP1. Size: ~16 h.

WP5: `/app` full-stack demo. Owns: `src/subsites/app/**`, `packages/node-runtime-shims`-level Hono adapter (or plain fetch handler, Hono is already in tests devDeps), route files persisted in VfsBus, request/response UI. Uses dits' contract-first shape (shared valibot schemas, one fetch client) but with handlers served through the sw-sandbox virtual origin. Acceptance: `app.spec` edits a route, restarts nothing, and sees the new response in the response viewer. Dependencies: WP1. Size: ~20 h.

WP6: `/vibe` vibe-coding sandbox. Owns: `src/subsites/vibe/**` (port of `examples/app-builder` `src/ai`, `src/container`, `src/ui` into the subsite, on WP1 panels), `src/subsites/vibe/ai/tools.ts` hardened per section 6, OPFS project persistence. Optionally: promote the tool layer to `packages/ai-tools` if WP3 also wants it (decide in WP6; default is subsite-local). Acceptance: `vibe.spec` with a mock provider (or recorded stream) drives a chat turn that writes a file and starts a dev server whose preview is observable. Dependencies: WP1. Size: ~24 h.

Parallelization: WP2 through WP6 can all run concurrently once WP1 merges (each touches only its own `src/subsites/<name>/` tree; WP3 also owns `packages/next-server`, nobody else does). WP1 is the only serialization point.

## 9. Ordering and estimates

1. WP1 (24 h) then WP2 + WP4 in parallel, then WP5 + WP6 + WP3 in parallel; total roughly 9 to 10 engineer-weeks, with WP3 the long pole.
2. Alternative if Next.js must ship first: start WP3 the day WP1's `boot.ts` helper lands, since it only needs the container API, not the IDE panels.
3. Explicit non-goals for this plan: real HMR/Fast Refresh, Next App Router, SSR React outside Next emulation, native npm modules, server-side anything.
