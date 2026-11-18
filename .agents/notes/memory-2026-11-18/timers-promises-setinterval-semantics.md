---
tags:
- bolo
- compat
---
Node's `timers/promises` setInterval generator (lib/timers_promises.js, v24) semantics that the bolo shim must mirror:

1. Ticks are counted in `notYielded`; the interval callback only resolves the parked `callback` resolver (single slot, set to undefined after use). Resolving an already-settled promise is a no-op — a tick landing while the consumer awaits its own work must increment the counter, not rely on waking.
2. `signal.aborted` is checked ONLY at the top of the outer `while` loop. Already-queued ticks are yielded BEFORE the AbortError propagates. Vendored test test-timers-interval-promisified.js aborts inside iteration 2 yet asserts totalIterations >= 3 (real Node v24 yields 8; bolo shim 7 — timing jitter, both fine).
3. Both quirks were needed: dropping queued ticks (old shim threw immediately after yield resumed) AND the stale `wake` resolver (first fix cleared `wake` after each tick).

Debugging gotcha: `packages/runtime/src/node-timers.ts` imports the shim from `dist/`, so shim source edits need `pnpm turbo run build --filter=@bolojs/node-web-shims` before runtime tests see them. Also the lefthook pre-push runs `pnpm validate` (turbo: typecheck+lint+format+test across all workspaces incl. compat-harness build) — a local `pnpm test` on one package is not enough to push.