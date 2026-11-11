---
"@bolojs/node-web-shims": minor
"@bolojs/wasm-registry": patch
---

Replace unenv's thin `node:stream` stubs with a faithful port of Node's `lib/internal/streams` semantics: real `Readable`/`Writable`/`Duplex`/`Transform`/`PassThrough` (function-constructor classes callable without `new`, legacy `Stream.call(this)` subclassing), backpressure (`highWaterMark`, `readableLength`/`writableLength`, `write()` return value + `'drain'`, `pipe()` await-drain), `cork()`/`uncork()` + `_writev` batching, `destroy(err)` → `'error'` → `'close'` ordering, `'prefinish'`/`'finish'` timing, `objectMode`, `Symbol.asyncIterator` (+ `map`/`filter`/… iterator helpers and `Symbol.asyncDispose`), `pipeline`/`finished`/`compose`/`addAbortSignal`/`duplexPair`, `stream/promises` (`pipeline`/`finished`), `stream/consumers` (`text`/`buffer`/`bytes`/`json`/`arrayBuffer`/`blob`), and `Readable`/`Writable`/`Duplex` `toWeb`/`fromWeb` interop with a `node:stream/web` module. Adds `stream/promises`, `stream/web`, `stream/consumers` subpath routing to the vite plugin and registers the new subpaths as node builtins in the bundler.
