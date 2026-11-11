---
"@bolojs/runtime": patch
"@bolojs/sandbox": patch
"@bolojs/pm": patch
"@bolojs/registry": patch
---

Fix the matrix-wedging hangs found by the compat harness (bolojs/bolo#123):

- `SpawnOptions.timeout` is now honoured end-to-end: `createProcess` auto-kills the spawned `NodeProcess` worker when the deadline passes, resolves `exit` with code 137, and closes the output stream — a program that never exits (ref'd handles keep its heartbeat alive, so the missed-heartbeat watchdog never fires) is reclaimed instead of hanging `exec()` forever.
- `BrowserContainer.teardown()` now calls `ShellService.killAll()`, which terminates every spawned process worker — rebooting between packages no longer leaks workers and OOMs the renderer.
- `bundleEntry` calls in `ShellService.runNodeApp` are wrapped in a 30s watchdog; on expiry the new `resetBundler()` export drops the cached rolldown/oxc module handles so the next call re-initialises instead of reusing a WASM instance poisoned by a sporadic `Atomics.wait cannot be called in this context` throw (which left the promise unsettled forever).
- Bounded handshakes: `SWSandbox`'s INIT_PORT → PORT_READY wait times out after 15s, and `IframeSandbox.init`'s `sandbox-ready`/`ready` waits after 10s, so a stuck boot fails fast instead of burning the package budget.
- `PackageManager` tarball fetches and registry packument fetches now carry a 30s `AbortSignal.timeout`, so a stalled registry cannot hang `install()`.
