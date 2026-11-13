---
"@bolojs/registry": patch
"@bolojs/compat-harness": patch
---

Fix npm-package interoperability failures found by the compat harness (bolojs/bolo#147):

- Class-valued builtin shims (unenv's real ES classes for `events`, `worker_threads`, `async_hooks`, ...) are now wrapped in a call-compatible function at bundle time, so legacy `Ctor.call(this)` subclassing (winston's `util.inherits` pattern) keeps working without touching the shim packages.
- A `globalThis.require` is injected by the bundle banner: UMD feature guards and optional-dependency probes that take a Node branch (sass's `require("url")`) resolve builtins through the live shim registry, and everything else throws Node's `MODULE_NOT_FOUND`.
- Unresolvable `require()`/`import()` specifiers inside `node_modules` now defer to a virtual module that throws `MODULE_NOT_FOUND` at require time instead of failing the whole bundle — native addon paths, platform bindings, and optional peers behind try/catch (rollup, parcel, jest, vite) degrade the way Node does.
- `.node` addons and NUL-byte binary payloads are stubbed as empty modules before parsing, ending binary `PARSE_ERROR` bundle failures.
- `existsSync`/`statSync`/`readFileSync`/`realpathSync` VFS probes are memoized for the duration of one `bundleEntry`, removing the repeated synchronous VFS round-trips that pushed wide dependency graphs (micromark) past the 30s bundler deadline.
- Unresolved bare specifiers fall back to versioned esm.sh URLs (matching the install-time import-map fallback) instead of failing the build; `node:`/`jsr:`/`data:` and other schemes still error honestly.
- The compat harness gains `package-expectations.json` with `{lane, reason, remediation}` classifications for native/WASM packages (esbuild, argon2, bcrypt, lightningcss, rspack, turbo), surfaced on each `PackageResult`; the dompurify probe now supplies a DOM via happy-dom and the tsc probe accepts every CJS-interop shape.
