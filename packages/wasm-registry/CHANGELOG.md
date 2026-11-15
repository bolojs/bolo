# @bolojs/registry

## 0.4.0

### Minor Changes

- [#161](https://github.com/bolojs/bolo/pull/161) [`0cc7ecb`](https://github.com/bolojs/bolo/commit/0cc7ecb65e9ac2e727956f498ec543a54568d819) Thanks [@espetro](https://github.com/espetro)! - WASM tool registry v1 ([#149](https://github.com/bolojs/bolo/issues/149)): `registerCuratedWasmTools`/`createCuratedWasmRegistry` ship curated `esbuild` and `swc` CLI tools (single-file transform over the VFS, `--version`, explicit unsupported-flag errors) loaded on demand from esm.sh with wasm binaries served through the existing OPFS-backed `loadBinary` cache. `boot()` now builds a default `createWasmRegistry()` (overridable via `BootOptions.wasmRegistry`), `ShellService` dispatches unrecognised shell commands through it before just-bash, and `NodeProcess`/process workers receive the registry so `child_process` wasm dispatch works inside spawned processes — workers re-register the curated set in their own realm.

  The default `nativeAddonLoader` (`createWasmNativeAddonLoader` + `warmWasmAddons`) resolves `.node` requires to curated WASM/JS variants — `argon2`→`argon2-wasm`, `lightningcss`→`lightningcss-wasm`, `bcrypt`→`bcryptjs` — with a `browser`-field fallback, warmed lazily the first time a bundle contains a `.node` require.

### Patch Changes

- [#128](https://github.com/bolojs/bolo/pull/128) [`422d0a6`](https://github.com/bolojs/bolo/commit/422d0a6e579f6678108893137cb343da65ae5ed3) Thanks [@espetro](https://github.com/espetro)! - Builtin-sweep batch (compat-matrix fixes). Bundler: injected Node globals (`process`, `Buffer`, `global`, `console`) are now bound as `__bc_*` banner vars with `transform.define` rewrites for unbound references only, so a bundled module that declares its own `Buffer`/`process`/`console` binding no longer hits a parse-time redeclare error. `v8` and `http2` are routed as builtins. Browser-field remaps resolve relative targets against the owning package root (was: importer dir), fixing `enhanced-resolve`-style builtin remaps (`"process": "./lib/util/process-browser.js"`).

  `node-web-shims`: new `v8` shim (heap stats, structuredClone-capable `serialize`/`deserialize`, `setFlagsFromString` no-op) and `http2` shim (`constants`, settings helpers, `Http2ServerRequest`/`Http2ServerResponse`, `sensitiveHeaders`; `connect`/`createServer`/`createSecureServer`/`performServerHandshake` throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).

  `node-runtime-shims`: `node:module` shim now exports `Module` (constructor + `_nodeModulePaths`, `createRequire`, `builtinModules`, `syncBuiltinESMExports`, `register`, `wrap`, compile-cache stubs), `findPackageJSON`, and `isBuiltin`; registry wires the new `v8`/`http2` shims.

- [#152](https://github.com/bolojs/bolo/pull/152) [`191db09`](https://github.com/bolojs/bolo/commit/191db096ac05effe6a4e0435181b9aeee037d3ad) Thanks [@espetro](https://github.com/espetro)! - Node core test pass for the Lane-A web shims: `util.inspect`/`formatWithOptions` honor `numericSeparator` (integer digits group in threes from the right, fractions in threes from the left, signs and exponents untouched, BigInts keep `n`); `assert.rejects`/`doesNotReject` render `ERR_INVALID_ARG_TYPE` "Received" text and `ERR_INVALID_RETURN_VALUE` inspect output like Node; `Buffer.from`/`concat` refuse >2^31-1 array-like lengths and total lengths with V8's `Invalid typed array length` RangeError; `perf_hooks` ships a real `PerformanceObserver` over the platform observer plus `PerformanceObserverEntryList`; stream scheduling prefers the container process shim's `nextTick` over `queueMicrotask`; crypto `argTypeError` messages quote strings and name constructors faithfully. The bundle banner's `Console.prototype.clear` now writes Node's `\x1b[1;1H\x1b[0J` sequence to stdout, `node:console` always resolves to the banner console, and rolldown's informational `[EVAL]` warning no longer fails compat runs.

- [#125](https://github.com/bolojs/bolo/pull/125) [`96021f1`](https://github.com/bolojs/bolo/commit/96021f18f76d818c3a4906966f98702e1a529160) Thanks [@espetro](https://github.com/espetro)! - Fix the matrix-wedging hangs found by the compat harness (bolojs/bolo#123):

  - `SpawnOptions.timeout` is now honoured end-to-end: `createProcess` auto-kills the spawned `NodeProcess` worker when the deadline passes, resolves `exit` with code 137, and closes the output stream — a program that never exits (ref'd handles keep its heartbeat alive, so the missed-heartbeat watchdog never fires) is reclaimed instead of hanging `exec()` forever.
  - `BrowserContainer.teardown()` now calls `ShellService.killAll()`, which terminates every spawned process worker — rebooting between packages no longer leaks workers and OOMs the renderer.
  - `bundleEntry` calls in `ShellService.runNodeApp` are wrapped in a 30s watchdog; on expiry the new `resetBundler()` export drops the cached rolldown/oxc module handles so the next call re-initialises instead of reusing a WASM instance poisoned by a sporadic `Atomics.wait cannot be called in this context` throw (which left the promise unsettled forever).
  - Bounded handshakes: `SWSandbox`'s INIT_PORT → PORT_READY wait times out after 15s, and `IframeSandbox.init`'s `sandbox-ready`/`ready` waits after 10s, so a stuck boot fails fast instead of burning the package budget.
  - `PackageManager` tarball fetches and registry packument fetches now carry a 30s `AbortSignal.timeout`, so a stalled registry cannot hang `install()`.

- [#153](https://github.com/bolojs/bolo/pull/153) [`587d758`](https://github.com/bolojs/bolo/commit/587d75858239f9bdc1a201b9fff9d998ff979399) Thanks [@espetro](https://github.com/espetro)! - Fix npm-package interoperability failures found by the compat harness (bolojs/bolo#147):

  - Class-valued builtin shims (unenv's real ES classes for `events`, `worker_threads`, `async_hooks`, ...) are now wrapped in a call-compatible function at bundle time, so legacy `Ctor.call(this)` subclassing (winston's `util.inherits` pattern) keeps working without touching the shim packages.
  - A `globalThis.require` is injected by the bundle banner: UMD feature guards and optional-dependency probes that take a Node branch (sass's `require("url")`) resolve builtins through the live shim registry, and everything else throws Node's `MODULE_NOT_FOUND`.
  - Unresolvable `require()`/`import()` specifiers inside `node_modules` now defer to a virtual module that throws `MODULE_NOT_FOUND` at require time instead of failing the whole bundle — native addon paths, platform bindings, and optional peers behind try/catch (rollup, parcel, jest, vite) degrade the way Node does.
  - `.node` addons and NUL-byte binary payloads are stubbed as empty modules before parsing, ending binary `PARSE_ERROR` bundle failures.
  - `existsSync`/`statSync`/`readFileSync`/`realpathSync` VFS probes are memoized for the duration of one `bundleEntry`, removing the repeated synchronous VFS round-trips that pushed wide dependency graphs (micromark) past the 30s bundler deadline.
  - Unresolved bare specifiers fall back to versioned esm.sh URLs (matching the install-time import-map fallback) instead of failing the build; `node:`/`jsr:`/`data:` and other schemes still error honestly.
  - The compat harness gains `package-expectations.json` with `{lane, reason, remediation}` classifications for native/WASM packages (esbuild, argon2, bcrypt, lightningcss, rspack, turbo), surfaced on each `PackageResult`; the dompurify probe now supplies a DOM via happy-dom and the tsc probe accepts every CJS-interop shape.
  - `__bc_callCompat` now passes non-class values through untouched (and treats primitive receivers as construction), so a shim export that is absent or non-callable in the live registry can no longer crash the bundle with "Invalid value used as weak map key".
  - esbuild's dual-format CJS wrapper (`var api = {}; ((module) => {...})({get exports(){return api}, set exports(v){...}})`, used by typescript.js) is detected at bundle time and its api var re-exported as the module default — `import ts from "typescript"` now yields the transpile API instead of undefined.
  - Per-package `timeoutMs` overrides (parcel, jest) are now honored by the CLI page watchdog, which previously applied the global 60s deadline to every package regardless of the matrix entry.

- [#124](https://github.com/bolojs/bolo/pull/124) [`448bbf8`](https://github.com/bolojs/bolo/commit/448bbf8098d7bdedc16d1a0fee79e16cf821db08) Thanks [@espetro](https://github.com/espetro)! - Replace unenv's thin `node:stream` stubs with a faithful port of Node's `lib/internal/streams` semantics: real `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` (function-constructor classes callable without `new`, legacy `Stream.call(this)` subclassing), backpressure (`highWaterMark`, `readableLength`/`writableLength`, `write()` return value + `'drain'`, `pipe()` await-drain), `cork()`/`uncork()` + `_writev` batching, `destroy(err)` → `'error'` → `'close'` ordering, `'prefinish'`/`'finish'` timing, `objectMode`, `Symbol.asyncIterator` (+ `map`/`filter`/… iterator helpers and `Symbol.asyncDispose`), `pipeline`/`finished`/`compose`/`addAbortSignal`/`duplexPair`, `stream/promises` (`pipeline`/`finished`), `stream/consumers` (`text`/`buffer`/`bytes`/`json`/`arrayBuffer`/`blob`), and `Readable`/`Writable`/`Duplex` `toWeb`/`fromWeb` interop with a `node:stream/web` module. Adds `stream/promises`, `stream/web`, `stream/consumers` subpath routing to the vite plugin and registers the new subpaths as node builtins in the bundler.

- Updated dependencies [[`96021f1`](https://github.com/bolojs/bolo/commit/96021f18f76d818c3a4906966f98702e1a529160), [`7f0ec39`](https://github.com/bolojs/bolo/commit/7f0ec39cdd21029dc79132304a4d5bcbb3437923)]:
  - @bolojs/pm@0.4.0

## 0.3.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/fs@0.3.0
  - @bolojs/pm@0.3.0

## 0.2.0-rc.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/fs@0.2.0-rc.0
  - @bolojs/pm@0.2.0-rc.0
