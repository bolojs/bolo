---
tags:
- bolo
- plans
---
# Compat fleet status (updated 2026-11-17 late session)

## Key breakthrough: rolldown 1.1.5 WASM OOM
`@rolldown/browser@1.1.5` (pinned ^1.1.5) dies with WASM "memory access out of bounds" on large npm module trees (linkedom, happy-dom 13MB/593 files, vite, parcel, jest trees). Raising the WASM memory cap does NOT fix it. 1.3.2 bundles the same trees fine. The harness reported this as "bundleEntry timed out after 30000ms — bundler wedged" because the deadline swallowed the crash. This ONE bug masked 5 npm package failures (vite, parcel, jest, dompurify, linkedom) since at least 2026-11-14.
- Fix committed: `.worktrees/npm-interop` commit 10809ce — upgrade ^1.3.2, patch ported (`patches/@rolldown__browser@1.3.2.patch`, sets `__asyncWorkPoolSize = 0`, the 1.1.5 patch's async-work-pool disable ported to the renamed constant). Also MAX_ERROR_LENGTH 500->8000 in package-runner.ts so harness failures show real errors.
- dompurify: PASS (2.8s). linkedom: PASS standalone (2.4s) but TIMED OUT (60s exec cap) when run after jest in the same session — order-dependent; re-verify.
- Also fixed in same worktree commit a546191: console method names after .bind (test-console-methods.js now passes; bind renames to "bound log", banner restores name via Object.defineProperty; groupCollapsed indent-before-write fix).

## Remaining npm failures with known root causes (subagents dispatched on .worktrees/npm-interop)
- vite: bundles now; dies at module init — esbuild's "Cannot find native binding" (optional-dep platform package missing). Bundle warnings show esbuild/yaml/jiti/tsx/@vitejs/devtools not installed (deferred MODULE_NOT_FOUND). Subagent tasked.
- parcel: bundles + probe prints PASS, then uncaught `Cannot find module "./artifacts/index.browser-x64.node"` from @parcel/rust dynamic require. Subagent tasked (Lane-B wasm mapping or honest Lane-C ledger entry).
- jest: bundles; dies with SecurityError — @unrs/resolver-binding-wasm32-wasi loaded from esm.sh tries to construct a cross-origin Worker (wasi-worker-browser.mjs from esm.sh origin). Needs local serving of that binding's worker script (same mechanism as the repo's preferLocalRolldown) or stubbing.
- linkedom: standalone PASS; recheck after the others land.

## node:* core tests
- Only 2 real failures remain of the 9 in the stale node-compat.json:
  - test-assert.js — assert.ok() generated message. Root cause CONFIRMED: `setOkExpressionSourceReader` in packages/node-web-shims/src/util/ok-expression.ts is never installed anywhere. Reader needs VFS wiring + blob-URL→path mapping. Subagent on .worktrees/npm-node-tests (branch feat/assert-ok-expression), slow to start, pinged twice with evidence.
  - test-console-methods.js — FIXED (a546191).
- Expectations ledger (apps/compat-harness/src/expectations.json): current, 7 C / 2 B / 1 A, no stale.

## Harness ops notes
- One vite dev server per worktree — ports 5173/5174 collide across worktrees; a server started in one worktree serves THAT worktree's files (saw cross-worktree leakage: 5174 served npm-interop paths from npm-dom-fails run). Always `rm -rf apps/compat-harness/node_modules/.vite` before restart; pkill both ports first.
- BUNDLE_TIMEOUT_MS lives in packages/runtime/src/shell-service.ts (30s default; I raised to 180s temporarily for diagnosis — REVERTED in committed tree, only local). package-runner has its own 60s exec cap (EXEC_TIMEOUT_MS).
- Package probes: apps/compat-harness/src/package-matrix.json. Native-addon expectations: src/package-expectations.json. Core-test ledger: src/expectations.json.
- The 111-package matrix currently at ~97-101 pass with the rolldown fix (esbuild, tsc, rollup, bcrypt, argon2, lightningcss, dompurify, linkedom pass; vite/parcel/jest pending; rspack/turbo/ws skip by design).
