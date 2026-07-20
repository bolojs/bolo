# @bolojs/example-app-builder

## Purpose and constraint

This package exists to prove bolo's *existing* core infra (`packages/*`)
already supports a Lovable/v0/bolt.new-class AI app builder — chat-driven
file edits + installs + a live preview, entirely client-side. **Do not bend
core to fit this example.** If something here seems to need a core change,
that change must be generic infra any consumer benefits from (and lands as
its own commit in `packages/*`, not folded into this package). See
`README.md` for the full architecture writeup; this file is operational
notes for agents re-entering the folder, not a duplicate of it.

## Running it

```bash
pnpm --filter @bolojs/example-app-builder dev        # portless-fronted, see below
pnpm --filter @bolojs/example-app-builder typecheck
pnpm --filter @bolojs/example-app-builder build       # tsc --noEmit && vite build
```

`dev` runs through `portless` (root convention, stable `.localhost` URL) —
it needs the portless HTTPS proxy on :443, which isn't always available in a
sandboxed/CI shell. If `portless` hangs or you just need a quick QA server,
bypass it directly:

```bash
pnpm --filter @bolojs/example-app-builder exec vite --port 5183 --strictPort
```

Kill it when done (`lsof -i :5183`, then `kill <pid>`) — a stray background
Vite process from a previous session is easy to leave running by accident.

### Stale `dist/` gotcha

This package consumes `bolojs`, `@bolojs/fs`, and
`@bolojs/vite-preset` via their built `dist/` output (no TS path-mapping in
`tsconfig.base.json`). If you edit those packages' source, rebuild them
before app-builder will see the change:

```bash
pnpm --filter bolojs --filter @bolojs/fs --filter @bolojs/vite-preset build
```

Symptom if you skip this: TS errors like "has no exported member" for
things you just added, or silently-old runtime behavior.

## QA

No automated test suite exists for this package yet (no `vitest.config.ts`,
no Gauge/e2e specs) — verification so far has been manual, via the
`playwright-cli` skill against a real dev server and a real (free-tier,
see below) OpenRouter key. If you add real coverage, prefer Gauge +
Playwright under `tests/e2e/` per root convention over hand-rolled scripts.

Known-working manual flow: open the dev server → if `OPENROUTER_API_KEY`
is set in `examples/app-builder/.env`, the dev-only plugin in
`vite.config.ts` injects it as `window.__OPENROUTER_DEV_KEY__` and the
config dialog auto-skips; otherwise it auto-opens and asks for a paste →
pick model(s) → Save → send a prompt → watch plan text stream, then
tool-call receipts, then the preview iframe populate once the model runs
`npm run dev`.

### Observability before debugging

Lead rule: before diagnosing any preview, container, worker, or service-worker failure in this package, install the observability harness first. Do not debug blind. The default `playwright-cli console` command only captures the page console; module worker (`worker-script.js`) and service worker (`sw.js`) consoles, async worker errors, and failed network requests are invisible without the harness.

Logging: `src/main.tsx` calls `configureBrowserLogging()` from `@bolojs/log/browser` before render, and `packages/runtime/src/worker-script.ts` calls it inside the module worker with `self` error and unhandledrejection listeners that post STDERR. Browser logs are console-only (no file sink); everything surfaces in the page or worker console where the harness captures it. Category overrides: see `packages/log/AGENTS.md`.

Harness workflow (copy the four commands from the script comment). Note: `run-code` invocations run in an isolated evaluation context, so a previous call's `globalThis` is not visible to the next. The harness instead exposes a window function via `page.exposeFunction`, so the drain runs in the browser window context with `eval`, which persists across `run-code` calls. Use the named persistent session `-s=appdbg --persistent` to keep IndexedDB/OPFS/service-worker state across sessions instead of paying a full boot and npm install every time.

```bash
playwright-cli -s=appdbg open --persistent
playwright-cli -s=appdbg run-code --filename=examples/app-builder/scripts/pw-observe.js
playwright-cli -s=appdbg goto http://127.0.0.1:4402/
# ... reproduce the failure ...
playwright-cli -s=appdbg eval "await window.__boloObsDrain()"
```

What each captured line means: `console.*` are page messages (including structured `@bolojs/log` JSON lines); `pageerror` is an uncaught page error with stack; `requestfailed` and `http-4xx/5xx` catch SW-served 503 timeouts and worker-import 404s; `workercreated`/`workerclosed` bracket module worker lifecycles; `sw-created` fires when the sw-sandbox service worker registers; `sw-state` snapshots registration states every 5s (look for `controller: false` to confirm the "Waiting for dev server..." gate).

If `__boloObsDrain` is undefined, the harness was not installed or the page context was reset; re-run the install command.

### Dev-injected OpenRouter key

The `devOpenRouterKey` plugin (`vite.config.ts`) reads
`process.env.OPENROUTER_API_KEY` server-side and injects it as
`window.__OPENROUTER_DEV_KEY__` into `index.html` — **dev-only**, no-op
in `vite build`. `providers.ts` falls back to that global when
localStorage is empty, and `App.tsx` persists it into localStorage on
first use so subsequent reloads don't depend on the dev plugin.

Why server-side injection (vs `VITE_OPENROUTER_API_KEY`): `VITE_*` env
vars are statically substituted into the bundle at build time, which
would bake the key into the JS payload and any deploy artifact. The dev
plugin reads the key only on the running dev process and ships it via
`transformIndexHtml`, so it lives in dev-server memory and the network
response to the dev tab only — never in the built artifact.

Localstorage always wins once a user has saved a key via the dialog; the
dev key is purely a fresh-tab default. Rotate the `.env` value to force
a refresh across existing tabs.

Debugging persisted state: localStorage keys are all prefixed
`bolo-app-builder:` (`openrouter-api-key`, `plan-model-id`,
`build-model-id`, `use-same-model`); the project filesystem snapshot lives
in IndexedDB under `bolo-app-builder` / store `projects` / key `default`
(`src/container/persist.ts`). Clearing site data resets everything.

## Model policy

**Use only free OpenRouter models** for dev/QA in this example — no billed
model calls against the demo key.

Free models are `id`s ending `:free` (e.g. `meta-llama/llama-3.1-8b-instruct:free`,
`tencent/hy3:free`). Don't hardcode a list — discover them live via
OpenRouter's `/api/v1/models` endpoint (`listOpenRouterModels()` in
`src/ai/providers.ts`) and filter for the `:free` suffix, same endpoint
`ConfigDialog.tsx` already queries to populate the plan/build model
pickers.

## Implementation gotchas

- `runCommand` (`src/container/tools.ts`) times out waiting on `proc.exit`
  after 5s and reports long-lived processes (e.g. `npm run dev`) as
  still-running rather than blocking — expected, not a hang. Found live: the
  first version of this tool `await`ed `proc.exit` unconditionally and
  deadlocked the chat forever the moment the model ran the dev server.
- `src/main.tsx` deliberately does **not** wrap `<App />` in `<StrictMode>`.
  `boot()` (`packages/runtime/src/boot.ts`) is a process-wide container
  singleton; React 19 StrictMode's dev-only double-invoke of effects races
  two overlapping boot/teardown cycles against it. Don't re-add StrictMode
  here without also fixing that races.
- `tsconfig.json` sets `"types": ["node", "vite/client"]` — dropping `node`
  (e.g. copying a plain Vite app's tsconfig) breaks `Buffer`/`globalThis`
  typing in `src/client-globals.ts`, since `tsconfig.base.json`'s default
  `["node"]` gets fully overridden, not merged, by a package-level `types`.
- Path building (`tools.ts`, `App.tsx`) consistently does
  `` `${container.workdir}/${path}`.replace(/\/+/g, "/") `` — follow that
  pattern for new container-fs paths rather than plain string concatenation,
  to avoid double slashes when `path` is empty or already-prefixed.
- `git` (`packages/runtime/src/commands/git.ts`, backed by isomorphic-git)
  runs in the VFS hot layer (memfs), so `.git/` and any cloned repo evaporate
  on page reload or worker teardown. Remote operations (clone/fetch/pull/push)
  route through the public CORS proxy `https://cors.isomorphic-git.org`,
  which is rate-limited — for repeated QA either self-host a relay or
  shallow-clone (`--depth=1` is the default). Supported subset: init, clone,
  status, add, commit, log, branch, checkout, fetch, pull, push, remote, diff.
  No merge, rebase, stash, reset --hard, or GPG signing.
