# @bolojs/sandbox

## 0.3.1

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

- [#81](https://github.com/bolojs/bolo/pull/81) [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62) Thanks [@espetro](https://github.com/espetro)! - Process model: every Node process now runs in its own Worker.

  - Worker-per-process spine with remote dependency loading and a synchronous worker-main channel (SharedArrayBuffer plus sync XHR through the service worker).
  - Real `kill()`: terminating a process tears down its worker and handles.
  - Faithful exit codes: `process.exit()` is uncatchable, uncaught crashes run `exit` handlers and report a non-zero code, and output is gated after exit.
  - Event-loop liveness: handle-tracked timers and servers keep a process alive until idle, with `process.nextTick` queue and macrotask `setImmediate` semantics matching Node.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/log@0.3.0

## 0.2.0-rc.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

- [#81](https://github.com/bolojs/bolo/pull/81) [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62) Thanks [@espetro](https://github.com/espetro)! - Process model: every Node process now runs in its own Worker.

  - Worker-per-process spine with remote dependency loading and a synchronous worker-main channel (SharedArrayBuffer plus sync XHR through the service worker).
  - Real `kill()`: terminating a process tears down its worker and handles.
  - Faithful exit codes: `process.exit()` is uncatchable, uncaught crashes run `exit` handlers and report a non-zero code, and output is gated after exit.
  - Event-loop liveness: handle-tracked timers and servers keep a process alive until idle, with `process.nextTick` queue and macrotask `setImmediate` semantics matching Node.

### Patch Changes

- Updated dependencies [[`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17)]:
  - @bolojs/log@0.2.0-rc.0
