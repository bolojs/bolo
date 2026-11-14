# Plan: lane-B backend seams — pluggable backend registries

Date: 2026-11-13. Companion research: [research/2026-11-13-pluggable-backend-registries.md](research/2026-11-13-pluggable-backend-registries.md). Scope: docs/planning only; no source changes made.

## Current state of the five seams

All five seams already exist as typed, optional constructor options on `createLiveShimRegistry` (`packages/node-runtime-shims/src/live.ts:170-204`) and are wired by hosts today:

| Seam | Type in live.ts | Wired by | Absent-backend behavior | Transport below it |
|---|---|---|---|---|
| `spawnProcess` | `ProcessSpawner` | `ShellService.spawnProcessForShim` (shell-service.ts:517-521, 604), rpc ops inside process workers | fork/Worker paths keep their stub behavior | `THREAD_MSG` rpc envelopes |
| `spawnSyncProcess` | `SyncRunner` | `remote.spawnSync` in node-process-worker.ts:324 | throws documented unsupported error | worker sync channel (`child.runSync` op) |
| `netBackend` | `(deps) => StreamBackend` | not wired by any in-repo host | `net-shim` default: `LoopbackTransport` (in-realm pipes) or `NoopTransport` with `ERR_BOL_UNSUPPORTED_NET_BACKEND` when tcpRelay is unset for external connect | `ByteTransport`: Loopback / WebSocket / WebTransport vs `apps/tcp-relay` |
| `dgramBackend` | `DgramBackend` | none | node-web-shims dgram skeleton, send() errors `ERR_BOL_UNSUPPORTED_DGRAM_BACKEND` | none (no Web API equivalent) |
| `tlsBackend` | `(deps) => StreamBackend` | none | node-web-shims tls skeleton, connect throws `ERR_BOL_UNSUPPORTED_TLS_BACKEND` | none (TLS-over-plain-transport has no Web API equivalent) |

The important finding from the ledger: the current lane-B entries in `apps/compat-harness/src/expectations.json` are 8 tests (dgram x1, module fixtures x2, net x2, tls x3). The spawnSync/spawn-family tests named in the task brief (spawnsync x4, `test-process-exit-code` x1) already have their seams implemented (`spawnSyncProcess` rides the worker sync channel; `spawnProcess` backs fork/worker_threads) and are not lane-B in the ledger; their remaining failures are module-resolution issues. This plan therefore treats seam *generalization* as the main deliverable and lists per-test unlocks against the actual ledger state.

## Proposed design: one generalized backend-registry pattern

Keep both existing bolo styles but unify their mechanics, mirroring wasm-registry v1 (name-keyed lazy loaders, promise cache, per-realm registration, structured failure, subpath exports) across the capability seams.

### 1. A shared `BackendRegistry` type (node-runtime-shims)

```ts
export type BackendFactory<B> = (deps: BackendDeps) => B;
export interface BackendRegistration<B> {
  readonly name: string;                       // "tcp-relay" | "loopback" | "udp-relay" | ...
  readonly create: BackendFactory<B>;
  readonly protocols?: readonly string[];      // for transports: ["ws", "webtransport"]
}
export type BackendCandidate<B> = B | BackendRegistration<B> | undefined;
```

Resolution follows rolldown `first`-hook semantics over an ordered candidate list; the first present candidate wins. Concretely:

```ts
resolveBackend(netCandidates): StreamBackend | undefined
// today's precedence, made explicit and single-sourced:
// options.netBackend -> tcpRelay-derived WebSocketTransport -> LoopbackTransport
```

This replaces the precedence currently implicit in `live.ts:336-341` with one function that is unit-testable and documented. Per the research conclusions this is declaration/activation separation: options remain cheap declarations; transports, relay sockets, and workers are constructed only when the shim is first used (lazy, matching Deno's lazy-closure discipline and wasm-registry's promise cache).

### 2. Per-seam interfaces (no breaking changes; tighten and document)

**netBackend / StreamBackend** stays as-is (`connect` + `isIP`), because `ByteTransport` already carries the connect/listen duality and the relay integrations. Add a `describe()` metadata method (name, protocols, capabilities: `{ outbound: boolean; inbound: boolean; tlsOverIt?: boolean }`) so `net-shim` and docs can introspect what the active backend supports, which also lets `tlsBackend` declare what it needs from its underlying transport.

**dgramBackend** — currently a single-function type returning `{ createSocket }`. Promote to an interface with explicit lifecycle: `createSocket(type, callback)`, plus documented semantics for `bind()`, `send()` (including the empty-address callback path the ledger test exercises), `close()`, and `address()`. Reference implementation to ship alongside: a `UdpRelayTransport` against a WS-framed UDP relay (extend `apps/tcp-relay` with a `LISTEN_UDP`/`SEND_TO` frame type pair, reusing the existing 1-byte-type + 8-byte-connId framing). Fallback stays the node-web-shims skeleton with its coded error.

**tlsBackend** — TLS over an arbitrary byte transport. The seam should be `(deps) => TlsBackend` where `TlsBackend.connect(options, socket)` wraps an existing `net.Socket`-like stream (matching Node's `tls.connect({ socket })` overload) and `TlsBackend.createServer(secureContext)` accepts connections. Practical browser implementations, in order of effort: (a) delegate to `fetch`/`WebSocket` for the https-shaped subset (already how http-shim works), (b) run a TLS stack over the relay transport (rustls- or OpenSSL-to-WASM via the existing wasm-registry binary loader, the same mechanism `native-addon-resolver` uses for `.node` → WASM variants). Until one exists, the skeleton keeps throwing `ERR_BOL_UNSUPPORTED_TLS_BACKEND`; `test-tls-wrap-no-abort` may remain failing honestly since `TLSWrap` inspection has no faithful mapping (ledger note agrees).

**spawnProcess / spawnSyncProcess** — interfaces are correct as-is (`ProcessSpawner`, `SyncRunner`); no redesign. The remaining work is not seam work: (a) vendor the module fixtures or teach `module-shim` relative-`.js` require for `test-module-wrap`/`test-module-wrapper` (ledger remediation text, confirmed against module-shim.ts), and (b) for `test-process-exit-code` (spawn of the `node` binary), add a spawn-argv resolver inside the process-spawn path that maps `argv[0] === 'node'` (or `process.execPath`) to an in-container spawn instead of an exec attempt.

### 3. Relationship to the wasm-registry

Do not merge them. They share a *pattern* (keyed lazy loaders, per-realm registration, coded failure) but serve different extension audiences: wasm tools are content-addressed binaries loaded from CDNs/OPFS; network backends are in-graph TypeScript factories wired by the embedding host. What to generalize from wasm-registry is mechanical: the promise-cache-on-first-resolve idiom for expensive backend construction (relay connection, WASM TLS instantiation), `getRegisteredNames()`-style introspection for diagnostics, and the subpath-export discipline so a `@bolojs/node-runtime-shims/backends` subpath can carry relay/TLS implementations without inflating the default browser graph (the same trick commit 0981a6f used to keep `bundle.ts` out of browser graphs).

### 4. Realm propagation

Follow the existing rule at node-process-worker.ts:297-304: whatever the main thread registers, each process worker re-registers in its own realm. A `createBackendRegistrySnapshot()` (serializable registrations: names + config, not live objects) passed through the worker boot message keeps worker children consistent with the parent container without leaking transports across postMessage. `spawnProcess`/`spawnSyncProcess` already cross realms via rpc and need nothing new.

### 5. Coded-error taxonomy (keep, extend slightly)

Keep `ERR_BOL_UNSUPPORTED_<SEAM>` as the single missing-provider vocabulary (research: matches Playwright/Terraform best practice of error-with-remediation, and ServiceLoader's absent-vs-broken split). Add one distinction: *backend failed* errors (relay unreachable, UDP relay frame mismatch, TLS handshake failure) must surface the underlying cause with the backend name attached (`err.backend = "tcp-relay"`), never rewritten as UNSUPPORTED, so misconfiguration is distinguishable from absence. New codes needed: none for seams that exist; add `ERR_BOL_TLS_HANDSHAKE` only if/when a WASM TLS backend lands.

### 6. Migration path

1. **M1 — explicit resolution (small, zero behavior change):** extract `resolveBackend` candidate-list resolution; net precedence becomes declarative; unit tests pin it. No ledger movement.
2. **M2 — net unlock (2 ledger tests):** make the compat-harness configure a tcpRelay (or rely on LoopbackTransport for `test-net-connect-buffer` if in-realm loopback suffices once server-side socket semantics match; verify against `net-seam.test.ts` first). Unlocks `test-net-connect-buffer`, `test-timers-socket-timeout-removes-other-socket-unref-timer` (both fail on missing listening TCP socket).
3. **M3 — dgram backend + UDP relay (1 ledger test):** `DgramBackend` interface promotion + `UdpRelayTransport` + relay frame extension. Unlocks `test-dgram-send-callback-buffer-empty-address` (send callback semantics need a real socket backend).
4. **M4 — tls backend decision (0-2 ledger tests):** prototype path (a) https-subset delegation first; it may close `test-tls-legacy-deprecated` (deprecation warnings + shape) and `test-tls-ticket-12` needs a real handshake, likely requiring path (b). `test-tls-wrap-no-abort` stays honestly failing.
5. **M5 — module fixture resolution (2 ledger tests):** vendor `not-main-module.js` fixture or add post-bundle relative-`.js` require to `module-shim`. Unlocks `test-module-wrap`, `test-module-wrapper`. Independent of the backend registry; cheapest pair of wins in the ledger.
6. **M6 — spawn argv resolution (0 current lane-B, closes the brief's spawn family):** in-container resolution of `node` as spawn target inside `spawnProcess`.

### 7. Per-seam test coverage plan

| Seam / milestone | Ledger tests unlocked | New tests to add |
|---|---|---|
| M1 resolveBackend | none | live.test.ts: candidate ordering, absent-all fallback, backend failure surfacing |
| M2 net/tcpRelay | test-net-connect-buffer, test-timers-socket-timeout-removes-other-socket-unref-timer | net-shim.test.ts already covers transport selection; add relay-frame round-trip against a fake WS server (pattern exists in apps/tcp-relay/relay.test.js) |
| M3 dgram | test-dgram-send-callback-buffer-empty-address | dgram backend: bind/send/empty-address callback/close semantics; relay frame test |
| M4 tls | test-tls-legacy-deprecated, maybe test-tls-ticket-12 | tls skeleton connect-error code assertions (exists), handshake success over loopback once a backend exists |
| M5 module fixtures | test-module-wrap, test-module-wrapper | module-shim relative-require resolution tests |
| M6 spawn argv | (spawn family from the brief) | child-process-shim argv-resolution test with a fake ProcessSpawner |

### 8. Open questions

- Does `test-net-connect-buffer` pass with LoopbackTransport alone (in-realm loopback), or does it need a real relay? The ledger reason says in-process loopback "times out in-container", suggesting a net-shim server-side bug rather than a missing backend; investigate before building M2 on the relay.
- UDP relay operationally: WebContainers/Nodebox simply refuse UDP; hosting a public UDP relay widens the self-host footprint (apps/tcp-relay is user-operated). Should dgram support be documented as "self-host relay only" from day one?
- TLS path (a) vs (b): the https-subset delegation covers much of `got`-style usage but almost none of the tls test surface; is a WASM TLS stack worth the binary weight given compat payoff is 1-2 tests?
- Should `LoopbackTransport` remain the *default* (current behavior) or become opt-in? Loopback gives false confidence for tests that assume real sockets; WebContainers analog is that localhost-only is genuinely supported.
- Per-realm re-registration for backends: pass a snapshot through worker boot (proposed) or have workers reconstruct from config? Snapshot keeps parity but adds a boot-message field.
