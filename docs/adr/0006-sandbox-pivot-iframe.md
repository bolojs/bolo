# ADR-0006: Sandbox Pivot to Browser-Native Iframe Isolation

## Status

Accepted — 2026-07-11

## Context

The QuickJS-based sandbox had lying contracts:
- `createSwGate` was dead code (never wired into SWSandbox fetch handlers)
- `vfs.use(createVfsAcl())` was never called (V8-tier writes bypassed ACL entirely)
- The "AI agent sandbox WORKS" claim in the ship-launch plan was false

Fixing the wiring (~2 hours) still leaves QuickJS as a ~250KB WASM bundle with ~500ms to 2s startup, a separate JS engine to maintain, and a dual-runtime testing burden. The browser already provides a proven, zero-cost isolation primitive: the same-origin policy via `sandbox="allow-scripts"` iframes.

almostnode.dev uses exactly this approach. No WASM sandbox. No QuickJS. Just a cross-origin iframe with browser-native V8. It works.

## Decision

Replace QuickJS with a cross-origin iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) as the default sandbox. The browser same-origin policy is the security boundary. The iframe gets an opaque origin and cannot access parent DOM, localStorage, sessionStorage, cookies, IndexedDB, OPFS, or SharedArrayBuffer.

Move QuickJS to `@browser-containers/quickjs-sandbox` as an opt-in community package for users who need memory caps, CPU instruction counting, or per-path filesystem ACLs.

## Consequences

**Lost (in default sandbox):**
- Memory limits
- CPU instruction counting
- Kill switch for infinite loops
- Per-require hooks
- Per-path filesystem ACLs

**Gained:**
- Zero WASM bundle (QuickJS WASM removed from default runtime)
- Instant startup (no QuickJS module initialization)
- One execution path (browser-native V8 only)
- No QuickJS maintenance burden

**Safari limitation:** Safari does not provide site isolation by default (behind an experimental flag). The iframe runs in the same OS process as the host tab. An infinite loop in the sandbox iframe will block the host tab. Origin-level isolation still works (opaque origin, no storage access). Users who need a kill switch on Safari can use the QuickJS opt-in package.

**VFS model:** Snapshot-based. On init, parent sends all text files in the workdir (excluding `node_modules`) to the iframe, which builds an in-memory `Map`. Writes update the in-memory map AND notify the parent via `postMessage`. Parent applies writes to the real VfsBus. This matches the `agent run` use case (run once and exit), so stale VFS is not an issue.
