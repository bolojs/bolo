---
"@bolojs/pm": minor
---

Run npm lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`) after tarball extraction. Opt-in via `runScripts: true | string[]` (constructor or per-`install()` call) — scripts are untrusted code and stay warn-only by default. Execution is delegated to an injected `scriptRunner` (`LifecycleScriptRunner`) so `@bolojs/pm` stays decoupled from the process layer; the container injects a spawned `NodeProcess` worker. Scripts run dependency-first with npm env (`npm_lifecycle_event`, `npm_package_*`, PATH incl. `node_modules/.bin`). `node-gyp`/`node-pre-gyp`/`cmake-js` invocations and `binding.gyp` packages are detected and skipped with diagnostics. Failure semantics match npm: non-zero exit fails the install via `LifecycleScriptError`, except optional dependencies and `prepare` (never run by npm for registry packages), which warn.
