---
"@bolojs/node-web-shims": patch
"@bolojs/wasm-registry": patch
---

Node core test pass for the Lane-A web shims: `util.inspect`/`formatWithOptions` honor `numericSeparator` (integer digits group in threes from the right, fractions in threes from the left, signs and exponents untouched, BigInts keep `n`); `assert.rejects`/`doesNotReject` render `ERR_INVALID_ARG_TYPE` "Received" text and `ERR_INVALID_RETURN_VALUE` inspect output like Node; `Buffer.from`/`concat` refuse >2^31-1 array-like lengths and total lengths with V8's `Invalid typed array length` RangeError; `perf_hooks` ships a real `PerformanceObserver` over the platform observer plus `PerformanceObserverEntryList`; stream scheduling prefers the container process shim's `nextTick` over `queueMicrotask`; crypto `argTypeError` messages quote strings and name constructors faithfully. The bundle banner's `Console.prototype.clear` now writes Node's `\x1b[1;1H\x1b[0J` sequence to stdout, `node:console` always resolves to the banner console, and rolldown's informational `[EVAL]` warning no longer fails compat runs.
