---
title: Node.js Compatibility
description: Compatibility tiers and support status for Node.js APIs and packages.
---

Check the [live compatibility dashboard](https://bolojs.dev/compat/) for real-time, tested
results. This page explains the tier model behind it.

## Compatibility tiers

Every package and API lands in one of four tiers. The tier determines how much (if any) shim
support is required.

- **T1: Web-Standard**: no shims, 100% coverage today.
- **T2: WinterTC Minimum**: no shims, ~90% coverage today.
- **T3: Node-API via shims**: shims required, ~85 to 90% coverage.
- **T4: Unsupported**: intentionally absent.

### T1: Web-Standard

Packages written against Web Standards only (`fetch`, `Request`, `Response`, `Headers`,
`ReadableStream`, `WritableStream`, `AbortController`, `SubtleCrypto`, `URL`, `Blob`, `FormData`,
etc.), with zero Node-specific imports. These run unmodified on native browser APIs with no shims.
This is the headline tier: Hono, Elysia, itty-router, and most modern edge-first frameworks land
here.

### T2: WinterTC Minimum (ECMA-429)

The [WinterTC][wintertc] (formerly WinterCG) Minimum Common Web Platform API standard, now
formalized as [ECMA-429][ecma429]. It defines the ~80 mandatory APIs every non-browser JavaScript
runtime agrees to provide: `fetch`, full Streams API, `TextEncoder`/`TextDecoder`,
`URL`/`URLPattern`, `CompressionStream`, `Blob`/`File`, WebCrypto, `WebAssembly.*`, `setTimeout`,
`queueMicrotask`, `structuredClone`, MessageChannel, and the Event/EventTarget family.

~90% coverage via native Web APIs plus `@bolojs/node-web-shims`. Known gaps: `navigator.userAgent`
is not wired, and `PromiseRejectionEvent`/`onunhandledrejection`/`onrejectionhandled` are not
wired. Note the official WinterTC test suite (a WPT subset) is not yet published, so any
compliance claim should be hedged as "ECMA-429 2025 snapshot-aligned" until a runnable suite
exists.

[wintertc]: https://wintertc.org/
[ecma429]: https://min-common-api.proposal.wintertc.org/

### T3: Node-API via shims

Packages that import `node:*` builtins. We provide 28 builtins through two layers:
`@bolojs/node-web-shims` (unenv-backed Web API bridges) and `@bolojs/node-runtime-shims`
(runtime-backed factories for `fs`, `child_process`, `process`, `module`, `http`, `net`).

~85 to 90% coverage of real-world npm surface. The majority of mainstream npm packages that do not
depend on raw sockets, native addons, or server-only clustering run here.

#### Module status

| Module | Package | Status | Notes |
|--------|---------|--------|-------|
| `fs`, `fs/promises` | node-runtime-shims | Real | Backed by VfsBus (memfs + OPFS): `*Sync`, async, symlink/readlink/lstat |
| `http` (createServer) | node-runtime-shims | Real | VirtualServer via `@bolojs/sandbox` |
| `http` (client) | node-web-shims | Stub | fetch adapter only, no `ClientRequest`/`Agent` |
| `net` (createServer) | node-runtime-shims | Real (server) | Delegates to the http shim |
| `child_process` | node-runtime-shims | Partial | spawn/exec via WASM, no sync variants, stdio no-op |
| `fs.watch` | node-runtime-shims | Real | `VfsBus.watch()`; also backs `chokidar` |
| `process` | node-runtime-shims | Partial | cwd/hrtime/nextTick/stdout real, exit no-op, `memoryUsage()` returns zeros |
| `module` | node-runtime-shims | Partial | `createRequire` for builtins + `.json` only |
| `crypto` | node-web-shims | Real | WebCrypto via unenv |
| `stream` | node-web-shims | Real | WebStreams via unenv |
| `buffer` | node-web-shims | Real | ArrayBuffer/Uint8Array via unenv |
| `path` | node-web-shims | Real | path-browserify via unenv |
| `url` | node-web-shims | Real | URL/URLSearchParams via unenv |
| `events` | node-web-shims | Real | EventEmitter via unenv |
| `os` | node-web-shims | Stub | Minimal stub via unenv |
| `worker_threads` | node-web-shims | Real | Minimal wrapper around threads.js |
| `util` | node-web-shims | Real | `promisify`/`inherits`/`types`/format via unenv |
| `querystring` | node-web-shims | Real | `parse`/`stringify`/`escape`/`unescape` via unenv |
| `async_hooks` | node-web-shims | Real | `AsyncLocalStorage`/`AsyncResource` via unenv |
| `diagnostics_channel`, `tty` | node-web-shims | Stub | No-op implementations |
| Shell commands (pipes, redirection, quoting) | bolojs | Real | `just-bash` interpreter backed by VfsBus |
| `wasm32-wasip1` CLI binaries | @bolojs/registry | Real | Generic WASI loader, filesystem + args/env only, no sockets/threads/fork |

Gaps that rarely block mainstream packages: `http.request()`/`http.get()`/`ClientRequest`/`Agent`
(client HTTP is `fetch`-only), `child_process` sync variants (`execSync`/`spawnSync`/`execFile`/
`fork`), `fs.watch` firing bogus self-closing events in edge cases.

### T4: Pluggable / unsupported (intentional)

Builtins that require capabilities a browser cannot provide safely or at all. Catalogued in
`PLUGGABLE_BUILTIN_NAMES` (`packages/node-runtime-shims/src/module-shim.ts:49`):

- `cluster`, `dgram`, `tls`: raw sockets, TLS, clustering. `dgram` and `tls` can be back-ended via
  `createLiveShimRegistry`; `cluster` has no browser mapping.
- `dns`, `http2`, `inspector`, `v8`, `wasi`, `test`, `repl`, `trace_events`, `domain`: not yet
  provided, most out of scope for a browser runtime.
- `https`: aliases the `http` shim in the browser context.
- Native addons (NAPI) are pluggable via `nativeAddonLoader`; otherwise they throw.

## Bottom line

The runtime targets workloads that run on Cloudflare Workers, Deno Deploy, or edge runtimes, plus
the added advantage of real `node:fs` and `node:stream` support. This covers Hono, Express,
Fastify, Elysia, the Vercel AI SDK, and most AI agent frameworks. The gaps in T3 rarely block
mainstream packages, and T4 is intentionally absent. Missing something you need? See
["Extending bolo"](/docs/api/#extending-bolo) in the API reference.
