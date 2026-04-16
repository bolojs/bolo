# Dogfood Report: browser-containers demo

| Field | Value |
|-------|-------|
| **Date** | 2026-04-16 |
| **App URL** | http://localhost:5173/ |
| **Session** | browser-containers-dogfood |
| **Scope** | React + Vite Preview (v0.2.0 gate) spec validation |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

All previously identified issues have been resolved and the v0.2.0-react-vite.spec scenarios pass successfully.

## Fixed Issues

### ISSUE-001: Demo app fails to render — blank page with JS runtime errors on load

**Status:** FIXED

**Root causes identified and fixed:**
1. `packages/node-web-shims/src/vite-plugin.ts` had a broken `unenv/runtime/node/` resolution block that caused `EventEmitter` to be undefined during Vite pre-bundling. Removed the incorrect resolution.
2. `apps/demo/vite.config.ts` had an additional broken alias mapping `unenv/runtime/node/*` to `*/index.mjs`. Removed.
3. `packages/node-web-shims/package.json` was missing exports for `./dist/*` files, causing esbuild pre-bundling to fail when aliasing `node:events` etc. Added `"./dist/*": "./dist/*"` export.
4. `packages/sw-sandbox/src/sw-sandbox.ts` waited for an unreliable `SW_READY` broadcast from the service worker. Fixed by using a `MessageChannel` `PORT_READY` acknowledgment.
5. `apps/demo/public/sw.js` was missing a `fetch` event listener entirely. Added the handler to proxy requests through the sandbox.
6. `packages/runtime/src/boot.ts` hardcoded the sandbox origin to `https://sandbox.local/`. Fixed to use `globalThis.location?.origin`.
7. `packages/sw-sandbox/src/sw-sandbox.ts` `handleFetchRequest` passed an empty string body to GET/HEAD requests, causing `Request` construction to fail. Added a guard to only include body for non-GET/HEAD methods.
8. `packages/vite-server/src/browser-vite-server.ts` used dynamic `import('typescript')` via `@sebastianwessel/quickjs`, which fails in browser bundles. Rewrote to use static `import * as ts from 'typescript'` and `ts.transpile()` directly.
9. `packages/runtime/src/shell-service.ts` did not use `BrowserViteServer` for `npm run dev`. Updated to instantiate and start `BrowserViteServer`, enabling TSX transformation and importmap injection.

### ISSUE-002: Page title does not match spec

**Status:** FIXED

`apps/demo/index.html` title changed from `"browser-containers demo"` to `"browser-containers"`.

## Validation Results

The following v0.2.0-react-vite.spec checks were verified via a Playwright-based dogfood session:

- Page title is `"browser-containers"` :white_check_mark:
- Service worker registers and is active :white_check_mark:
- npm install auto-populates VFS (react exists, importmap exists) :white_check_mark:
- Preview iframe displays `Hello from browser-containers!` :white_check_mark:
- Preview hot-reload works (`Updated!` appears after file change) :white_check_mark:
- TSX transformation works (no raw JSX in fetched module) :white_check_mark:

## Evidence

All 277 unit tests pass (`pnpm test`). Build (`pnpm build`) and typecheck (`pnpm typecheck`) are clean.
