# @bolojs/compat-harness

## 0.1.2

### Patch Changes

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

- Updated dependencies [[`422d0a6`](https://github.com/bolojs/bolo/commit/422d0a6e579f6678108893137cb343da65ae5ed3), [`cf40f67`](https://github.com/bolojs/bolo/commit/cf40f676735a3f012f4bc697c192d68c222fa9a3), [`b6bb9ed`](https://github.com/bolojs/bolo/commit/b6bb9ed4ff0f94099de5ec587d4511e33d21e799), [`05f331e`](https://github.com/bolojs/bolo/commit/05f331e673022e2b4bcc16c479b237c2b48646ae), [`191db09`](https://github.com/bolojs/bolo/commit/191db096ac05effe6a4e0435181b9aeee037d3ad), [`96021f1`](https://github.com/bolojs/bolo/commit/96021f18f76d818c3a4906966f98702e1a529160), [`229f749`](https://github.com/bolojs/bolo/commit/229f749ea826c124ad94b8f1e4ec19292090dc70), [`5d18830`](https://github.com/bolojs/bolo/commit/5d188305c1db0f649e54429cde3202ba9c8fc96b), [`91b7a70`](https://github.com/bolojs/bolo/commit/91b7a70d35358885a126c07cce468d3f99e2514f), [`448bbf8`](https://github.com/bolojs/bolo/commit/448bbf8098d7bdedc16d1a0fee79e16cf821db08), [`0cc7ecb`](https://github.com/bolojs/bolo/commit/0cc7ecb65e9ac2e727956f498ec543a54568d819), [`52737a2`](https://github.com/bolojs/bolo/commit/52737a2d733fa55f237c69bf97466994c57f37df), [`4005562`](https://github.com/bolojs/bolo/commit/4005562a2bc2441429ca01429c56eb7c0a5730e7), [`12bcca5`](https://github.com/bolojs/bolo/commit/12bcca56b7a2752e65acb486c242c6065d50e0de)]:
  - @bolojs/node-web-shims@0.4.0
  - @bolojs/runtime@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17), [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62)]:
  - @bolojs/runtime@0.3.0
  - @bolojs/log@0.3.0
  - @bolojs/node-web-shims@0.3.0

## 0.1.1-rc.0

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17), [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62)]:
  - bolojs@0.2.0-rc.0
  - @bolojs/log@0.2.0-rc.0
  - @bolojs/node-web-shims@0.2.0-rc.0
