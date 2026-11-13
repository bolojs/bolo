# Research: pluggable backend registries and provider/capability seams

Date: 2026-11-13. Scope: how mature projects architect pluggable/external registries and provider seams, and which of those patterns bolo should adopt for its backend seams (spawnProcess, spawnSyncProcess, netBackend, dgramBackend, tlsBackend) and its existing wasm-registry (`packages/wasm-registry`). Companion implementation plan: [../2026-11-13-lane-b-backend-seams.md](../2026-11-13-lane-b-backend-seams.md).

## Where bolo stands today (baseline for comparison)

bolo already has two distinct seam styles. The first is the wasm-registry v1 pattern (`packages/wasm-registry/src/registry.ts`): a realm-local `Record<string, WasmToolLoader>` singleton with `registerWasmTool(name, loader)` for eager registration and `resolveWasmTool(name)` for lazy, promise-cached resolution, plus `createWasmRegistry().dispatch()` which returns a structured `{ stdout, stderr, exitCode: 1 }` failure when no tool is registered. Curated tools are re-registered per realm because process workers are separate JS realms (`packages/runtime/src/node-process-worker.ts:297-304`), and heavy bundler deps stay out of browser graphs via subpath exports (`@bolojs/registry/curated-tools`).

The second style is constructor-injected backend options on `createLiveShimRegistry` (`packages/node-runtime-shims/src/live.ts:170-204`): `spawnProcess`, `spawnSyncProcess`, `netBackend`, `dgramBackend`, `tlsBackend`, `workerThreadsBackend`, `nativeAddonLoader`. When a backend is absent, the shim throws a greppable coded error (`unsupportedError(seam, msg)` in `packages/node-web-shims/src/coded-error.ts:40`) using the `ERR_BOL_UNSUPPORTED_<SEAM>` family (`NET_BACKEND`, `DGRAM_BACKEND`, `TLS_BACKEND`, `SPAWN_SYNC`, ...), and the error message names the exact remediation (register via `createLiveShimRegistry({ netBackend })` or configure a `tcpRelay`). `net-shim.ts` additionally has a transport hierarchy below the backend seam: `ByteTransport` with `NoopTransport`, `LoopbackTransport` (in-realm pipes, the default), and `WebSocketTransport`/`WebTransportTransport` against the `apps/tcp-relay` reference relay.

The expected-fail ledger (`apps/compat-harness/src/expectations.json`) currently carries 8 lane-B entries (dgram x1, module fixtures x2, net x2, tls x3). The lane-B workstream broader scope (17 tests) also includes the spawnSync/spawn family, whose seams already exist in code (`spawnSyncProcess` wired to `remote.spawnSync` at `node-process-worker.ts:324`; `spawnProcess` wired at `shell-service.ts:517-521,604`) and whose remaining failures are fixture/resolution issues (relative `.js` require post-bundle) rather than missing seams.

## Per-project findings

### unenv (unjs/unenv)

Registration/discovery is purely build-time: `defineEnv({ presets, overrides })` merges an ordered list of `Preset` objects (`{ alias, inject, external, polyfill, meta }`) into one environment that the bundler consumes. Host-specific presets are separate npm packages (`@cloudflare/unenv-preset`) so vendor logic never lands in unenv core. Versioning is delegated to the host's compatibility-date model; presets carry `meta.version` for introspection only. Everything is eager at bundle time but tree-shakeable. Fallback semantics are the interesting part: three explicit tiers — real polyfill, `notImplemented(name)` which throws `[unenv] ${name} is not implemented yet!` at call time, and (in v1) a `MockProxy` returning infinite callable mocks; v2 deliberately removed the silent proxy mocks in favor of fail-loud stubs. Failure is at invocation, never at import. Maintainability traits: declarative data, compositional presets, externalized host presets. Known weakness: flattened aliases made "hybrid native+polyfill" modules hard, resolved only via `process.getBuiltinModule()` as an escape hatch (unenv issue #181). Sources: github.com/unjs/unenv; PR #427, #438, #450; issue #181.

### Cloudflare Workers (workerd + @cloudflare/unenv-preset)

Capability is decided by a compatibility-date/flag matrix, not a registry: native `node:*` modules are implemented in workerd's C++ core, `node:net` sockets are wired onto the proprietary `cloudflare:sockets` module (`connect()` returning Web streams with `startTls()`), and the unenv preset (`getCloudflarePreset({ compatibilityDate, compatibilityFlags })`) classifies every module as native / hybrid / polyfill with per-module `enable_*`/`disable_*` flags gated on dates. Unsupported surfaces (`net.Server`, `tls.Server`, dgram before its date) throw "Not implemented" at call time. Maintainability is centralized (single owner) but the date+flag matrix is complex (23+ override generator functions in preset.ts). Lesson for bolo: a *classification table* (what is native vs shimmed vs unsupported per capability) is valuable documentation and test-oracle even when there is no runtime registry. Sources: developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ and /nodejs/; workers-sdk `packages/unenv-preset/src/preset.ts`.

### Deno and Bun node-compat layers

Neither has a pluggable registry. Deno registers node builtins as a compiled-in `deno_core` extension (`ext/node`) with Rust ops plus TS polyfills, and the polyfill set is explicitly lazy (`lazy_loaded_esm`): the node closure only deserializes on first `node:*` use, saving snapshot cost. Bun implements `node:net`/`node:tls` in a JS layer over Zig/BoringSSL with symbol-injected natives, and drives compat by vendoring Node's own upstream test suite and fixing gaps (net 94.4%, tls 70.3% upstream pass per PR #31155); gaps like missing TLS session resumption are documented rather than mocked. Lesson: bolo already follows Bun's test-suite-driven approach with compat-harness; the useful borrow is Deno's lazy-loading discipline (do not pay for a backend until a builtin that needs it is touched). Sources: docs.deno.com/runtime/fundamentals/node/; denoland/deno `ext/node/lib.rs`; bun.com/docs/runtime/nodejs-compat.

### WebContainers (StackBlitz) and Nodebox (CodeSandbox)

Closed-source WebContainers compile real Node to WASM and virtualize the OS layer (filesystem via ServiceWorker interception, virtual TCP stack, processes as isolates); there is no plugin registry, capabilities are whatever the WASM kernel implements, and unsupported binaries fail as shell errors. Nodebox explicitly states it "does not emulate Node.js but is Node-compatible": it polyfills `fs`/`net` in workers and publishes a documented limitation list (no external-IP sockets, no N-API, no `worker_threads`), so missing capability is a documented gap that fails at connect, not a stub. Lesson: publishing an honest capability matrix (what bolo already does at bolojs.dev/docs/shim-coverage, referenced from the error messages) is the competitive practice; a runtime registry is not required for honesty. Sources: blog.stackblitz.com/posts/webcontainer-api-is-here/; codesandbox nodebox-runtime repo and sandpack FAQ.

### wasmCloud capability providers

The strongest external-provider model in the survey. Providers are swappable host plugins implementing a WIT interface, distributed as signed provider archives (platform-specific binaries in a tar + JWT claims) via OCI registries. Components never touch providers directly: the host mediates runtime links over NATS using wRPC, and every component-to-provider access requires an explicit link (deny by default). Configuration arrives at startup (`HostData`) and per link. Versioning is by WIT interface plus signed claims. The Q3 2025 roadmap is instructive: wasmCloud is *removing* the host-launches-provider model in favor of "any wRPC server" — i.e. providers become ordinary addressable endpoints over a transport, which drastically simplifies the operational model. Lesson for bolo: bolo's netBackend/tcpRelay split already rhymes with this (backend = local factory, relay = remote endpoint over WS/WebTransport); the wasmCloud direction says prefer "addressable endpoint over a transport" over "in-process plugin binary". Sources: wasmcloud.com/docs/v1/concepts/providers/ and /linking-components/; github.com/wasmCloud/wasmCloud issue #4642.

### Terraform provider protocol

Plugins are subprocesses speaking versioned gRPC; `hashicorp/go-plugin` handles handshake, version negotiation (a `VersionedPlugins` map; client and server select a mutually supported major version), and supervision. Discovery is a source chain: explicit `provider_installation` mirrors, then the public registry, then dev overrides; a lock file pins versions. If no source can supply the provider, `init` fails with an explicit error, never a silent stub. Lesson: single handshake point for version negotiation, and a host-side stable interface so core never learns the wire version. Relevant if bolo backends ever become out-of-process (relay) or third-party-distributed. Sources: developer.hashicorp.com/terraform/plugin/how-terraform-works; github.com/hashicorp/terraform `docs/plugin-protocol/README.md`.

### VS Code extension API

Static manifest with declarative `contributes` (readable without loading code) plus `activationEvents` for lazy activation; `extensionKind` declares where the extension prefers to run (ui vs workspace), and the host resolves placement. Versioning is per-feature proposed APIs gated by manifest flags rather than whole-API versions. Missing provider = inertness (commands never appear), not an error. Lesson: separate *declaration* (cheap, inspectable) from *activation* (expensive, lazy) — this is exactly the split between `LiveShimRegistryOptions` fields and actual backend construction. Sources: code.visualstudio.com/api/references/extension-manifest, /activation-events, /advanced-topics/extension-host.

### Playwright browser/channel registry

A `Registry` of executable descriptors per browser/channel with per-platform paths, `installType` (`download-by-default`, `download-on-demand`, `install-script`, `none`), and revisions from `browsers.json`. Missing executable throws an error that *contains the exact remediation command* ("Executable doesn't exist at <path>" + `npx playwright install ...`). Lesson: error messages that carry the fix command are the gold standard; bolo's `ERR_BOL_UNSUPPORTED_*` messages already do this and should keep doing it. Sources: playwright.dev/docs/browsers; playwright-core `src/server/registry/index.ts`.

### Bundler plugin systems (rolldown, webpack/rspack, Vite)

Rolldown plugins are `{ name, hooks }` with hook kinds encoding semantics (`first` = run until non-null, `sequential`, `parallel`), object hooks `{ handler, order: 'pre'|'post', filter }` where `filter` lets the native core skip JS calls entirely. Vite layers `enforce: pre|post` and `apply` predicates, and ignores falsy plugins (env-conditional enable). webpack taps typed tapable hooks (bail = first non-undefined short-circuits). Lesson: hook *kinds* with explicit ordering and cheap filters, plus falsy-entry tolerance, are the current best practice for composable extension points; directly applicable if bolo ever supports multiple candidate backends per seam (e.g. loopback then relay fallback). Sources: rolldown.rs/apis/plugin-api; vite.dev/guide/api-plugin; webpack.js.org/contribute/writing-a-plugin.

### java.util.ServiceLoader and OSGi (historical)

ServiceLoader: providers declared in `META-INF/services/<fqcn>` text files, discovery is lazy on iteration, instantiation failures throw `ServiceConfigurationError` (an Error, deliberately, because a malformed provider file is a serious problem), and *zero providers found is not an error* — the caller supplies the default (`findFirst().orElse(default)`). OSGi pioneered dynamic publish-find-bind registries with service events and version ranges; its complexity is why modern systems chose static manifests plus lazy activation. Lessons: (1) declaration files that can be inspected without loading code, (2) distinguish "provider file malformed" (loud error) from "no provider" (caller-handled), which maps precisely onto bolo's distinction between a *misconfigured* backend (throw early) and an *absent* backend (coded unsupported error at call time). Sources: docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html; docs.osgi.org Specification Core 8 Service Layer chapter.

## Comparison table

| Project | Registration model | Discovery | Lazy loading | No-provider fallback | Maintainability traits |
|---|---|---|---|---|---|
| bolo live shims (baseline) | constructor options on `createLiveShimRegistry` | none (host wires explicitly) | backend constructed at registry build | `ERR_BOL_UNSUPPORTED_<SEAM>` throw at call time, remediation in message | factory-injected deps, realm-local, typed options |
| bolo wasm-registry v1 | `registerWasmTool(name, loader)` per realm | name lookup in realm-local map | lazy + promise-cached on resolve | structured `{ exitCode: 1 }` dispatch failure | curated package per realm, subpath exports keep deps out of graphs |
| unenv | build-time preset merge (`alias`/`inject`/`external`) | bundler alias resolution | tree-shakeable, no runtime cost | `notImplemented` throw at call time; v2 removed silent mocks | declarative data, externalized host presets; hybrid needs `getBuiltinModule` |
| Cloudflare Workers | compat-date/flag matrix + workerd natives | unenv preset classification | runtime natives, no bundle cost | "Not implemented" throw; unsupported falls to preset mock | centralized, generated preset; complex flag matrix |
| Deno | compiled-in extension ops | snapshot module map | `lazy_loaded_esm` closure | polyfill JS errors | single owner; lazy snapshot discipline |
| Bun | natives via symbol injection | none | eager runtime | documented gaps, native failure | upstream-test-suite-driven compat |
| WebContainers | none (WASM kernel) | n/a | n/a | shell-style errors | closed, centralized |
| Nodebox | build-time polyfills | none | eager | documented limitation list | honest capability matrix |
| wasmCloud | signed provider archives via OCI, explicit runtime links | lattice/registry | provider starts on link | link fails; deny-by-default | WIT interface versioning; moving to plain wRPC endpoints |
| Terraform | gRPC subprocess + handshake | source chain (mirror, registry, dev overrides) + lock file | process starts at use | `init` hard error, never silent stub | version negotiation at one handshake; host-side stable interface |
| VS Code | manifest `contributes` + `activationEvents` | marketplace + manifest scan | activation events | inertness (feature absent) | declaration separate from activation; proposed-API gating |
| Playwright | registry of executable descriptors | `browsers.json` + platform paths | on-demand install | boxed error naming the exact fix command | error carries remediation |
| rolldown/Vite plugins | plugin array in config | config order + filters | hook-level | plugin error surfaces into build; falsy entries ignored | hook kinds (`first`/`sequential`/`parallel`), `filter`, `order` |
| ServiceLoader | `META-INF/services` declaration files | classpath scan | lazy on iteration | zero providers is caller-handled; malformed file is a loud Error | declaration inspectable without loading code |
| OSGi | dynamic publish-find-bind | service registry + filters | service refs then materialization | service absent until registered | powerful but complex; modern systems avoid |

## Cross-cutting conclusions

1. Nobody in the node-compat space ships a runtime provider registry for builtins; the state of the art is build-time classification plus fail-loud call-time errors. Bolo is ahead of the field here because networked capabilities genuinely need runtime backends (browser constraints), and its `ERR_BOL_UNSUPPORTED_*` pattern matches the best observed error semantics (Playwright/Terraform: explicit error with remediation, never a silent stub).
2. The strongest pattern to generalize from bolo's own code is wasm-registry v1: name-keyed loaders, lazy promise-cached resolution, per-realm re-registration, structured failure, subpath exports for dependency hygiene. The lane-B backends differ only in that they are keyed by capability rather than by tool name and their factories take `BackendDeps`.
3. Declaration should stay separate from activation. `LiveShimRegistryOptions` already declares backends as optional factories; nothing should construct a transport, relay connection, or worker until a shim actually needs it (Deno's lazy-closure discipline, VS Code's activation events).
4. Ordering/fallback between candidate backends (loopback vs relay vs custom) should use rolldown-style explicit semantics: first-wins resolution with an ordered candidate list, not implicit precedence scattered through the shims. Today the precedence (options.netBackend over tcpRelay over LoopbackTransport default) is encoded in `live.ts` but not surfaced as a single resolvable decision.
5. Missing-provider vs broken-provider must stay distinct: absent backend = coded unsupported error at the API surface; present-but-failed backend (relay unreachable, handshake mismatch) = the underlying transport error, surfaced with context. ServiceLoader's split (ServiceConfigurationError vs empty iterator) is the canonical justification.
6. If backends are ever distributed (a relay is already a separate process), adopt a single versioned handshake (Terraform/go-plugin style) rather than ad-hoc protocol checks; the WS relay frame format is currently unversioned, which is acceptable while the relay is reference-only but is the first thing to version before third parties depend on it.
7. A public capability-classification table (native / shimmed / backend-required / unsupported per module, per surface) — the Cloudflare preset idea — would make the compat ledger, the docs shim-coverage page, and the `ERR_BOL_UNSUPPORTED_*` codes derivable from one source instead of three.

## Sources

- github.com/unjs/unenv (README; PR #427, #438, #450; issue #181)
- github.com/cloudflare/workers-sdk `packages/unenv-preset/src/preset.ts`; developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ and /nodejs/
- docs.deno.com/runtime/fundamentals/node/; github.com/denoland/deno `ext/node/lib.rs`
- bun.com/docs/runtime/nodejs-compat; github.com/oven-sh/bun PR #31155
- blog.stackblitz.com/posts/webcontainer-api-is-here/; github.com/codesandbox/nodebox-runtime; sandpack.codesandbox.io/docs/resources/faq
- wasmcloud.com/docs/v1/concepts/providers/ and /linking-components/; github.com/wasmCloud/wasmCloud issue #4642
- developer.hashicorp.com/terraform/plugin/how-terraform-works and /framework/provider-servers; github.com/hashicorp/terraform `docs/plugin-protocol/README.md`; github.com/hashicorp/go-plugin
- code.visualstudio.com/api/references/extension-manifest, /activation-events, /advanced-topics/extension-host
- playwright.dev/docs/browsers; github.com/microsoft/playwright `packages/playwright-core/src/server/registry/index.ts`
- rolldown.rs/apis/plugin-api; vite.dev/guide/api-plugin; webpack.js.org/contribute/writing-a-plugin
- docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html; docs.osgi.org (Core 8, Service Layer)
- Local: packages/wasm-registry/src/registry.ts, curated-tools.ts, native-addon-resolver.ts; packages/node-runtime-shims/src/live.ts, net-shim.ts, child-process-shim.ts; packages/node-web-shims/src/coded-error.ts; packages/runtime/src/node-process-worker.ts, shell-service.ts; apps/tcp-relay/index.js; apps/compat-harness/src/expectations.json

Walls hit: Exa search rate-limited on several queries (both research passes); workerd `src/cloudflare/sockets.md` raw fetch 404 (Cloudflare TCP sockets docs used instead); osgi.org overview page 404 (OSGi Core 8 spec chapter substituted). No other sources unreachable.
