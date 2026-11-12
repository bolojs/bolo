---
"@bolojs/node-web-shims": patch
---

Node core-test edge fixes: `util.format` now maps Symbol to `'NaN'` under `%d`/`%i`/`%f` (instead of throwing "Cannot convert a Symbol value to a number"), renders BigInt with its `n` suffix for `%d`/`%i`, uses `parseInt` semantics for `%i`, inspects objects for `%s`, and reports `%j` cycles as `'[Circular: ~]'`. `Buffer.alloc` surfaces V8's `Invalid typed array length: N` RangeError past the 32-bit limit, `Buffer.from`'s `ERR_INVALID_ARG_TYPE` message lists `SharedArrayBuffer` like Node 22, and `Buffer.prototype.toString('utf8')` decodes through `TextDecoder` so invalid sequences consume maximal subparts (one U+FFFD) exactly like V8 — aligning the chunked `StringDecoder` output with a one-shot `Buffer.toString` for `test-string-decoder-fuzz`. `StringDecoder('utf8')` no longer strips a leading BOM, and `crypto.Hmac` gains the legacy `write`/`end`/`read` stream surface Node's `LazyTransform` exposes.
