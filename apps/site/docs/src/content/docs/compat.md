---
title: Node.js Compatibility
description: Compatibility tiers and support status for Node.js APIs and packages.
---

This document assesses how much of the Node.js ecosystem actually runs in
browser-containers, organized into tiers. For the per-module implementation
table, see [shim-coverage.md](/docs/shim-coverage/).

## Compatibility tiers

We classify every package and API into one of four tiers. The tier determines
how much (if any) shim support is required.

| Tier | Label | Requires shims? | Coverage |
|------|-------|-----------------|----------|
| T1 | **Web-Standard** | No | 100% today |
| T2 | **WinterTC Minimum** | No (Web APIs) | ~90% today |
| T3 | **Node-API via shims** | Yes | ~85 to 90% |
| T4 | **Unsupported** | n/a | Intentionally absent |

### T1: Web-Standard

Packages written against Web Standards only (`fetch`, `Request`, `Response`,
`Headers`, `ReadableStream`, `WritableStream`, `AbortController`,
`SubtleCrypto`, `URL`, `Blob`, `FormData`, etc.). Zero Node-specific imports.

**Coverage: 100%.** These run unmodified on native browser APIs with no
shims. This is the headline tier: Hono, Elysia, itty-router, and most modern
edge-first frameworks land here.

### T2: WinterTC Minimum (ECMA-429)

The [WinterTC][wintertc] (formerly WinterCG) Minimum Common Web Platform API
standard, now formalized as [ECMA-429][ecma429]. This tier defines the ~80
mandatory APIs every non-browser JavaScript runtime agrees to provide:
`fetch`, full Streams API, `TextEncoder`/`TextDecoder`, `URL`/`URLPattern`,
`CompressionStream`, `Blob`/`File`, WebCrypto, `WebAssembly.*`,
`setTimeout`, `queueMicrotask`, `structuredClone`, MessageChannel, and the
Event/EventTarget family.

**Coverage: ~90%** via native Web APIs plus `node-web-shims`. Known gaps:

- `navigator.userAgent` is not wired.
- `PromiseRejectionEvent` and the `onunhandledrejection` / `onrejectionhandled`
  handlers are not wired.

Closing these gaps is low effort. Once closed, we can publish a compliance
audit against the ECMA-429 2025 snapshot and market a measurable percentage.
Note the official WinterTC test suite (a WPT subset) is not yet published, so
any claim should be hedged as "ECMA-429 2025 snapshot-aligned" until a runnable
suite exists.

[wintertc]: https://wintertc.org/
[ecma429]: https://min-common-api.proposal.wintertc.org/

### T3: Node-API via shims

Packages that import `node:*` builtins. We provide 28 builtins through two
layers: `node-web-shims` (22 unenv-backed Web API bridges) and
`node-runtime-shims` (6 runtime-backed factories for `fs`, `child_process`,
`process`, `module`, `http`, `net`).

**Coverage: ~85 to 90%** of real-world npm surface after the A1 to A4 work
(globals injection, expanded builtins, `fs.*Sync` on memfs, real `http`/`net`
streams). The majority of mainstream npm packages that do not depend on raw
sockets, native addons, or server-only clustering run here.

Known gaps within T3 (rarely block mainstream packages):

- `http.request()` / `http.get()` / `ClientRequest` / `Agent`: our `http`
  shim is server-only (ServiceWorker). Client-side HTTP is `fetch`-only.
- `child_process`: `spawn`/`exec` work via WASM but stdio is a no-op;
  `execSync` / `spawnSync` / `execFile` / `fork` are missing.
- `fs.watch`: `on()` returns a bogus self-closing watcher.
- `process.memoryUsage()`: returns zeros.

#### Module-level status

| Module | Status | Notes |
|--------|--------|-------|
| `fs` (`*Sync`, async, symlink/readlink/lstat) | Real | Backed by VfsBus (memfs + OPFS) |
| `http` (createServer) | Real | VirtualServer via sw-sandbox |
| `http` (client) | Stub | fetch only, no `ClientRequest` |
| `net` | Real (server) | Delegates to createHttpShim |
| `child_process` | Partial | spawn/exec via WASM, no sync variants, stdio no-op |
| `process` | Partial | cwd/hrtime/nextTick/stdout real, exit no-op |
| `module` | Partial | createRequire for builtins + .json only |
| `async_hooks`, `diagnostics_channel`, `tty` | Stub | No-op implementations |
| Everything else in the 28 | Real | See [shim-coverage.md](/docs/shim-coverage/) |

### T4: Pluggable / unsupported (intentional)

Builtins that require capabilities a browser cannot provide safely or at all.
Catalogued in `PLUGGABLE_BUILTIN_NAMES` (`packages/node-runtime-shims/src/module-shim.ts:49`):

- `cluster`, `dgram`, `tls`: raw sockets, TLS, clustering. `dgram` and `tls` can be
  back-ended via `createLiveShimRegistry`; `cluster` has no browser mapping.
- `dns`, `http2`, `inspector`, `v8`, `wasi`, `test`, `repl`, `trace_events`,
  `domain`: not yet provided, most out of scope for a browser runtime.
- `https`: aliases the `http` shim in the browser context.
- Native addons (NAPI) are pluggable via `nativeAddonLoader`; otherwise they throw.

## Bottom line

The runtime targets workloads that run on Cloudflare Workers, Deno Deploy, or
edge runtimes, plus the added advantage of real `node:fs` and `node:stream`
support. This covers Hono, Express, Fastify, Elysia, the Vercel AI SDK, and
most AI agent frameworks. The gaps in T3 rarely block mainstream packages, and
T4 is intentionally absent.
