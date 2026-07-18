
## Vision

A fully client-side, drop-in Node.js/Bun/Deno runtime for the browser. Developers drop their existing project into bolo and it works — no lockfile conversion, no CLI replacement, no workarounds. Zero server dependency. FOSS, modular, and designed for early funding.

The project is also the foundation for AI agent platforms that need sandboxed, observable JavaScript execution with resource controls.

## Compatibility Tiers

bolo targets three compatibility tiers. Each tier has a different shim requirement and a different user proposition.

| Tier | Label | Shim required? | Covers |
|------|-------|----------------|--------|
| T1 | **Web-Standard** | No | Packages built on `fetch`, `ReadableStream`, `WebCrypto`, `URL`, etc. Hono, Elysia, itty-router, and most modern edge-first frameworks. **These run out of the box with zero shims.** |
| T2 | **WinterTC / ECMA-429** | No (Web APIs) | The [ECMA-429](https://min-common-api.proposal.wintertc.org/) minimum common Web API set. ~85-90% covered via native browser APIs + `node-web-shims`. Gaps: `navigator.userAgent`, `unhandledrejection` event (each <20 lines to close). |
| T3 | **Node-API via shims** | Yes | Packages that import `node:*` builtins. 28 builtins covered via two layers: `node-web-shims` (22 Web-API bridges via unenv) and `node-runtime-shims` (6 runtime-backed factories for `fs`, `http`, `net`, `child_process`, `process`, `module`). ~85-90% of real-world npm surface. |

### Tier 1: Web-Standard (100% coverage)

Packages written entirely against Web Standards: `fetch`, `Request`, `Response`, `ReadableStream`, `WritableStream`, `SubtleCrypto`, `URL`, `Blob`, `FormData`, `CompressionStream`, `TextEncoder/TextDecoder`, `BroadcastChannel`, `MessageChannel`, `AbortController`, `WebAssembly.*`, `setTimeout`, `queueMicrotask`, `structuredClone`.

**Coverage: 100%.** No shims needed. Libraries like Hono, Elysia, and itty-router run unmodified. The bundle contains zero shim bindings. This is the headline tier for marketing: *"Web-standard libraries run out of the box — no Node shims required."*

### Tier 2: WinterTC / ECMA-429 (~85-90% coverage)

The [WinterCG](https://wintertc.org/) minimum common Web platform API standard, formalized as [ECMA-429](https://min-common-api.proposal.wintertc.org/) by Ecma TC55. This is the API surface every non-browser JS runtime agrees to provide. Coverage is via native browser APIs plus `node-web-shims`. Marketing claim: "ECMA-429 2025 snapshot-aligned." When the official WPT subset test suite is published, a precise compliance percentage will be published.

### Tier 3: Node-API via shims (~85-90% coverage)

Packages that import `node:*` builtins. Covered by:
- `node-web-shims`: 22 Web-API bridges (`path`, `buffer`, `url`, `crypto`, `os`, `events`, `stream`, `util`, `async_hooks`, `querystring`, `worker_threads`, `string_decoder`, `tty`, `assert`, `zlib`, `constants`, `perf_hooks`, `timers`, `punycode`, `diagnostics_channel`, `readline`)
- `node-runtime-shims`: 6 runtime-backed factories (`fs` → VfsBus, `child_process` → just-bash/WASM, `process` → process shim, `module` → createRequire, `http` → VirtualServer via sw-sandbox, `net` → StreamBackend: WS relay for outbound `connect`, `http.createServer` alias for inbound)

### Tier 4: Intentionally Unsupported

These require capabilities a browser cannot provide safely or at all. All fail with a clear, documented reason.

| Capability | Why unsupported |
|-----------|----------------|
| `cluster` | No shared port binding between Workers |
| `fork()` / real POSIX fork | V8 has no heap-snapshot/clone API, no MMU access, no resumable continuations across isolates (see ADR-0007) |
| `tls.createServer()` / `https.createServer()` | No inbound TLS without raw sockets; the browser cannot terminate TLS for inbound without holding the private key locally |
| `dgram` / raw UDP | Browser sandbox — no raw socket API (future: WebTransport datagrams) |
| Native `.node` addons | No native binary execution |
| `inspector` (Chrome DevTools protocol) | No TCP server binding in browser |
| `test` runner | Requires PTY + `child_process` + file watching |
| Hardlink-based CAS (`pnpm` store, `vltpkg` cache) | OPFS and Filesystem Access API have no `fs.linkSync`. Content-addressed cold storage (ADR-0008) achieves the same dedup outcome by hash instead of hardlink, but a real on-disk hardlink CAS is still impossible. |

**Emulable with reduced fidelity (T3-level):**
- `child_process.spawn()` — Tier 3 via Worker + message IPC; covers run script in subprocess and capture output. Now has bidirectional IPC (`process.send`/`message` events between parent and child) and monotonic pid allocation.
- `repl` - interactive REPL shipped as `ReplService` (persistent eval in RuntimeWorker + VFS-backed history + multi-line continuation); the `node:repl` builtin module itself remains unsupported.
- `vm` — shimmed via `quickjs-emscripten-core` in the `vm` builtin shim (separate from the runtime sandbox)
- `https` client — shimmed via `fetch` (TLS is built in)
- `dns` — full resolve surface shipped: `Resolver` class, all `resolve*` variants, and real `dns.reverse` via DoH PTR queries. Still DoH-based (Cloudflare `https://cloudflare-dns.com/dns-query`).
- `net.connect()` (outbound TCP) — emulated via a self-hosted WebSocket relay (ws → TCP bridge). TCP data frames use binary WebSocket framing (no base64); WebTransport is available as an alternative ByteTransport alongside WebSocket. Reference implementation at `apps/tcp-relay/`, self-hosted and user-operated. Known limitations tracked as follow-ups: relay rate limit (10/IP/60s, issue #33), no backpressure/pause/resume/`setNoDelay` yet (#34), no WS heartbeat/keepalive (#36).
- `net.Server.listen()` (inbound TCP) — emulated via the same self-hosted relay. The relay holds the public listener; the browser handles connection logic. TCP data frames use binary WebSocket framing (no base64); WebTransport is available as an alternative ByteTransport alongside WebSocket. **Caveats (non-negotiable):** (1) tab-close ephemeral — listener dies when the browser tab closes or is evicted; (2) `server.address().port` returns the relay's port, not a browser-side port; (3) abuse is the user's responsibility — publicly-exposed relay listener will attract scanners and SYN floods within minutes; (4) no hosted relay — OSS ships a reference implementation at `apps/tcp-relay/`, self-hosted and user-operated; (5) `server.close()` is cooperative (signals relay to tear down; does not forcibly reset in-flight connections on other paths). Known limitations tracked as follow-ups: relay rate limit (10/IP/60s, issue #33), no backpressure/pause/resume/`setNoDelay` yet (#34), no WS heartbeat/keepalive (#36).
- `tls.connect()` (outbound TLS) — rides the same relay with relay-side TLS termination (planned; seam designed, not yet shipped)
- `fs.watch` — push-based via VfsBus observers; VFS-internal mutations only (cross-tab/real-disk changes not visible)
- `process.memoryUsage()` — best-effort via `performance.memory` (Chrome-only) or ArrayBuffer enumeration

## Architecture

The full architecture is documented in `.agents/docs/ARCHITECTURE.md`. In brief: a trusted V8 Web Worker runs user code against a live `node:*` shim registry, backed by a two-layer VFS and bridged through a ServiceWorker proxy on the virtual origin. An untrusted iframe sandbox tier runs AI agent code. Package management details are below.

### Package management

- **Install strategies:** `PackageManager` supports `browser-native` (resolve from the npm registry when no lockfile is present) and `lockfile-only` (parse the existing lockfile with `@unjs/lockfile` and fetch the resolved tarball URLs). Both read npm, yarn, pnpm, and bun lockfiles and install entirely in the browser with `fetch()`.
- **Virtual store (ADR-0008):** installs materialize a pnpm-style symlinked virtual store rather than a flat `node_modules`, so diamond dependencies (two packages needing different versions of the same dependency) resolve correctly instead of silently collapsing to one version. Peer dependencies are linked on a best-effort graph-wide semver match; `.bin` entries are linked per-package and at the root; a failing optional dependency is skipped with a warning instead of failing the install.
- **Decompression and integrity:** Tarballs are decompressed with the native `DecompressionStream` API and integrity is verified with `crypto.subtle`.
- **Cache:** Packument responses are cached in `.npm-cache/` inside the VFS with a 7-day TTL.
- **Cold-storage dedup (ADR-0008):** the OPFS/IndexedDB cold layer is content-addressed — files are stored once per unique `sha256` hash with per-hash refcounting, deduping byte-identical files across installed packages without needing hardlinks.
- **JSR:** `jsr:` specifiers resolve via `npm.jsr.io` (Deno's JSR npm-compatibility mirror). A bundler `jsr:` alias plugin rewrites imports.
- **Fallback:** esm.sh CDN URLs are generated for the import map so packages that are not installed locally still resolve.

## Scope (v1)

### In scope

- Three-tier Node.js compatibility (T1 Web-Standard, T2 WinterTC/ECMA-429, T3 Node-API via shims)
- `node:fs`, `node:crypto`, `node:stream`, `node:http`, `node:path`, `node:buffer`, `node:url`, `node:events`, `node:os`, `node:child_process`, `node:worker_threads`, `node:module`, `node:process`, `node:net`, plus 20+ more via `node-web-shims`
- just-bash POSIX shell running against the VFS hot tier, with extra builtin commands `curl`, `nc`, `tcping`
- Interactive REPL via `ReplService` (persistent eval context, VFS-backed history, multi-line continuation); the `node:repl` builtin module remains unsupported
- Multi-format lockfile compatibility (npm, yarn, pnpm, bun) via `@unjs/lockfile`
- Virtual filesystem backed by memfs (hot) + OPFS (cold)
- ServiceWorker-based network proxy for virtual localhost
- WASM-based tool registry (esbuild, tsc, sass, swc)
- Vite dev server running in the browser
- Two-tier runtime: V8 (user code) + IframeSandbox (AI agents)
- Opt-in sandbox policy with network, memory, CPU, and filesystem restrictions
- Backend framework compatibility: Hono, Express, Koa, Fastify, Elysia, Nitro, tRPC
- Vendored Node.js test suite harness as the primary compatibility metric
- Live compatibility dashboard published to GitHub Pages

### Out of scope (v1)

- Next.js App Router, Pages Router (requires server-side features)
- Webpack (requires `require()` node_modules walking, eval, and plugin hooks unavailable in browsers)
- `cluster` module (no shared port binding in browsers)
- `fork()` / real POSIX fork (no shared memory between Workers)
- `dgram` / raw UDP sockets (no browser API; future: WebTransport datagrams)
- `tls.createServer()` / `https.createServer()` (no inbound TLS without raw sockets)
- Native `.node` addons (no native binary execution)
- ShadowRealm / sandboxed iframe as a third isolation tier (V8 + QuickJS dual-tier is sufficient)
- `inspector` module (Chrome DevTools protocol server — requires TCP)
- `test` runner (requires PTY + `child_process`)
- SSR / Server Components
- Hardlink-based content-addressable stores (browser filesystem has no `fs.linkSync`). ADR-0008's content-addressed cold storage achieves the dedup outcome by hash instead; a real hardlink CAS stays impossible.

## Target Users

1. **Developers** who want to try Node.js libraries in the browser without setup, or who want to embed a browser-native runtime in their product
2. **AI agent platforms** that need sandboxed, observable JavaScript execution with resource controls (opencode, claude-code, pi-agent)
3. **Educators** who need zero-install Node.js environments for teaching
4. **Tooling authors** who want to run Node.js-based build tools (esbuild, vite, tsc) in-browser without a server

## Package Manager Compatibility

| Package manager | Lockfile read | CLI runnable | Strategy |
|----------------|---------------|--------------|----------|
| **npm** | ✅ `package-lock.json` | ✅ | browser-native |
| **yarn v1** | ✅ `yarn.lock` | ❌ | `@unjs/lockfile` → fetch tarballs |
| **pnpm** | ✅ `pnpm-lock.yaml` | ❌ | `@unjs/lockfile` → fetch tarballs |
| **bun** | ✅ `bun.lock` / `bun.lockb` | ❌ | `@unjs/lockfile` → fetch tarballs |
| **JSR** | N/A | N/A | `npm.jsr.io` mirror + `jsr:` alias |

**Note:** All four lockfile formats produce an identical install graph. A project with a `yarn.lock` or `pnpm-lock.yaml` works in bolo without any conversion — the lockfile is read, resolved, and tarballs are fetched directly from the `resolved:` URLs already in the lockfile.

## Modularity

The project is structured as a pnpm monorepo. Each package is independently consumable:

- `@bolojs/vfs-bus` — standalone VFS (memfs + OPFS)
- `@bolojs/node-web-shims` — 22 `node:*` → Web API bridges (unenv-backed, works in any project)
- `@bolojs/node-runtime-shims` — runtime-backed shim factories
- `@bolojs/sandbox-policy` — ACL-based sandbox policy
- `@bolojs/wasm-registry` — WASM tool loader (esbuild, tsc, sass, swc)
- `@bolojs/runtime` — container API (RuntimeWorker + SandboxPool)
- **`@unjs/lockfile`** — standalone, framework-agnostic multi-format lockfile parser (published to npm, MIT, zero bolo deps)

## License

Apache 2.0 throughout. All dependencies are MIT/BSD/ISC — no GPL conflicts.
