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

This package consumes `@bolojs/runtime`, `@bolojs/vfs-bus`, and
`@bolojs/vite-preset` via their built `dist/` output (no TS path-mapping in
`tsconfig.base.json`). If you edit those packages' source, rebuild them
before app-builder will see the change:

```bash
pnpm --filter @bolojs/runtime --filter @bolojs/vfs-bus --filter @bolojs/vite-preset build
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
