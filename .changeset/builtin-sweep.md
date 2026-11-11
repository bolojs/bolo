---
"@bolojs/registry": patch
"@bolojs/node-web-shims": minor
"@bolojs/node-runtime-shims": minor
---

Builtin-sweep batch (compat-matrix fixes). Bundler: injected Node globals (`process`, `Buffer`, `global`, `console`) are now bound as `__bc_*` banner vars with `transform.define` rewrites for unbound references only, so a bundled module that declares its own `Buffer`/`process`/`console` binding no longer hits a parse-time redeclare error. `v8` and `http2` are routed as builtins. Browser-field remaps resolve relative targets against the owning package root (was: importer dir), fixing `enhanced-resolve`-style builtin remaps (`"process": "./lib/util/process-browser.js"`).

`node-web-shims`: new `v8` shim (heap stats, structuredClone-capable `serialize`/`deserialize`, `setFlagsFromString` no-op) and `http2` shim (`constants`, settings helpers, `Http2ServerRequest`/`Http2ServerResponse`, `sensitiveHeaders`; `connect`/`createServer`/`createSecureServer`/`performServerHandshake` throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).

`node-runtime-shims`: `node:module` shim now exports `Module` (constructor + `_nodeModulePaths`, `createRequire`, `builtinModules`, `syncBuiltinESMExports`, `register`, `wrap`, compile-cache stubs), `findPackageJSON`, and `isBuiltin`; registry wires the new `v8`/`http2` shims.
