---
"@bolojs/registry": minor
"@bolojs/runtime": minor
"@bolojs/node-runtime-shims": patch
---

WASM tool registry v1 (#149): `registerCuratedWasmTools`/`createCuratedWasmRegistry` ship curated `esbuild` and `swc` CLI tools (single-file transform over the VFS, `--version`, explicit unsupported-flag errors) loaded on demand from esm.sh with wasm binaries served through the existing OPFS-backed `loadBinary` cache. `boot()` now builds a default `createWasmRegistry()` (overridable via `BootOptions.wasmRegistry`), `ShellService` dispatches unrecognised shell commands through it before just-bash, and `NodeProcess`/process workers receive the registry so `child_process` wasm dispatch works inside spawned processes — workers re-register the curated set in their own realm.

The default `nativeAddonLoader` (`createWasmNativeAddonLoader` + `warmWasmAddons`) resolves `.node` requires to curated WASM/JS variants — `argon2`→`argon2-wasm`, `lightningcss`→`lightningcss-wasm`, `bcrypt`→`bcryptjs` — with a `browser`-field fallback, warmed lazily the first time a bundle contains a `.node` require.
