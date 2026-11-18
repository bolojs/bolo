---
tags:
- bolo
- workflow
---
# Compat harness workflow + gotchas (2026-11-11, PR #140)

- Harness run: `cd apps/compat-harness && pnpm exec vite --port 5199 --host`, then `node bin/cli.js --mode node-tests --url http://localhost:5199 --tests "<regex>" --json --output /tmp/out.json --raw-output /tmp/raw.json`. Restart vite + `rm -rf node_modules/.vite` after any dist change.
- Only manifest-listed files run; ad-hoc debug tests need a manifest entry — restore via `git checkout src/manifest.json` afterwards (editing it with python json.dump reorders arrays → don't).
- Env-blocked Node tests (not shim gaps): sync child_process (`spawnSync`/`execSync` throw), `common.spawnPromisified` (spawns real node binary → rejects with plain object → "Uncaught [object Object]"), `net.Server.listen` without TCP relay, unshimmed builtins (`domain`, `internal/timers`, `internal/test/binding`, `node:test`).
- `common.spawnPromisified`'s `child.on('error')` rejects with `{code,signal,stderr,stdout}` — that's the "[object Object]" signature.
- Worker 'exit' event: parent process must stay alive while a spawned thread lives. Fixed in `packages/runtime/src/node-process-worker.ts` via `liveThreads` (only `spec.threadId !== undefined`, i.e. worker_threads — child_process spawns must NOT keep the parent alive or test-process-exit-code times out on 11 concurrent bundles). Poll with `sleep(10)`, don't `Promise.race` (blocks the loop).
- V8 delete-error text uses the constructor's *name binding*: `class process extends EventEmitter {}` (class expression) prints `#<process>`; setting `constructor:` property does nothing. Deleting a non-configurable prop only throws in strict mode.
- Node coded errors: `err.name === "TypeError"` but `String(err)` is `TypeError [ERR_INVALID_ARG_TYPE]: ...`. `withCode()` helper in `packages/node-web-shims/src/coded-error.ts` implements this (name getter + toString override).
- timers/promises: `signal: null` must reject (only `undefined` means absent); NodeEventTarget accepted via duck-typing on addEventListener/removeEventListener.
- `class X extends EventEmitter {}` at module scope named X, then `Object.assign(obj, {constructor: X})` — Object.assign copies the constructor property value; that does NOT affect V8's `#<X>` output.
- unenv quirks: `createHook` no-op; `events.getEventListeners` crashes (`kEvents is not defined`); `promisify` reads its own module symbol, not Node's.
- Harness internal shims live in `apps/compat-harness/src/test-common.ts` (`internalShimSources`, e.g. `internal/event_target` NodeEventTarget with kEvents Map).
- Chromium for playwright: `/Users/josocjoq/Library/Caches/ms-playwright/chromium-1228`.
- `pnpm validate` runs on pre-push (lefthook); first push attempt can fail transiently — retry.
