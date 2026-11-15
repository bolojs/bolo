# @bolojs/pm

## 0.4.0

### Minor Changes

- [#121](https://github.com/bolojs/bolo/pull/121) [`7f0ec39`](https://github.com/bolojs/bolo/commit/7f0ec39cdd21029dc79132304a4d5bcbb3437923) Thanks [@espetro](https://github.com/espetro)! - Run npm lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`) after tarball extraction. Opt-in via `runScripts: true | string[]` (constructor or per-`install()` call) — scripts are untrusted code and stay warn-only by default. Execution is delegated to an injected `scriptRunner` (`LifecycleScriptRunner`) so `@bolojs/pm` stays decoupled from the process layer; the container injects a spawned `NodeProcess` worker. Scripts run dependency-first with npm env (`npm_lifecycle_event`, `npm_package_*`, PATH incl. `node_modules/.bin`). `node-gyp`/`node-pre-gyp`/`cmake-js` invocations and `binding.gyp` packages are detected and skipped with diagnostics. Failure semantics match npm: non-zero exit fails the install via `LifecycleScriptError`, except optional dependencies and `prepare` (never run by npm for registry packages), which warn.

### Patch Changes

- [#125](https://github.com/bolojs/bolo/pull/125) [`96021f1`](https://github.com/bolojs/bolo/commit/96021f18f76d818c3a4906966f98702e1a529160) Thanks [@espetro](https://github.com/espetro)! - Fix the matrix-wedging hangs found by the compat harness (bolojs/bolo#123):

  - `SpawnOptions.timeout` is now honoured end-to-end: `createProcess` auto-kills the spawned `NodeProcess` worker when the deadline passes, resolves `exit` with code 137, and closes the output stream — a program that never exits (ref'd handles keep its heartbeat alive, so the missed-heartbeat watchdog never fires) is reclaimed instead of hanging `exec()` forever.
  - `BrowserContainer.teardown()` now calls `ShellService.killAll()`, which terminates every spawned process worker — rebooting between packages no longer leaks workers and OOMs the renderer.
  - `bundleEntry` calls in `ShellService.runNodeApp` are wrapped in a 30s watchdog; on expiry the new `resetBundler()` export drops the cached rolldown/oxc module handles so the next call re-initialises instead of reusing a WASM instance poisoned by a sporadic `Atomics.wait cannot be called in this context` throw (which left the promise unsettled forever).
  - Bounded handshakes: `SWSandbox`'s INIT_PORT → PORT_READY wait times out after 15s, and `IframeSandbox.init`'s `sandbox-ready`/`ready` waits after 10s, so a stuck boot fails fast instead of burning the package budget.
  - `PackageManager` tarball fetches and registry packument fetches now carry a 30s `AbortSignal.timeout`, so a stalled registry cannot hang `install()`.

## 0.3.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/lockfile@0.3.0
  - @bolojs/log@0.3.0

## 0.2.0-rc.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/lockfile@0.2.0-rc.0
  - @bolojs/log@0.2.0-rc.0
