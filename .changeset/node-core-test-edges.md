---
"@bolojs/node-runtime-shims": minor
"@bolojs/runtime": minor
---

Sync `child_process` (`spawnSync`/`execSync`/`execFileSync`) now runs for real inside process workers: the worker blocks on the sync channel while the main thread runs the child to completion through a new `child.runSync` op — sibling process workers for `node` specs (bundled file or `-e`/`-p` eval code, whose prelude now exposes `process`/`console`/`Buffer`/`require`), wasm-registry/shell dispatch for non-node commands — then ships buffered stdout/stderr/exit status back and the shim reconstructs Node's result shape (`{ pid, output, stdout, stderr, status, signal, error? }`, `ENOBUFS` on `maxBuffer` overflow, `ENOENT`-style error results). Without a backend the sync APIs keep the documented unsupported error; stdin `input` is not delivered.

`node:net` gains an in-process `LoopbackTransport` (crossed web-stream pipes: `ECONNREFUSED` on unbound ports, `EADDRINUSE` on double-bind, peer-close EOF), now the default when no `tcpRelay`/custom transport is configured, so `net.Server.listen` + `net.connect` pair client and server sockets inside the container. `new net.Server(options?, listener?)` and `new net.Socket(options?)` now accept the Node arg shapes — a non-transport first arg shifts back to `(options, connectionListener)` instead of failing with `_transport.listen is not a function`.

`fs` edges: `readFile`/`writeFile`/`mkdir`/`readFileSync`/`writeFileSync`/`mkdirSync` validate their path/data args synchronously (`ERR_INVALID_ARG_TYPE` before any callback or IO, like Node), `readFile*` accept open fds and return a real `Buffer` when no encoding is given (hot-layer reads go through memfs instead of the utf8-string VFS path), `writeFile` honours `flag`/`mode`, and `mkdirSync` forwards memfs' recursive-created-path return. `fs.promises.open` returns a `FileHandle` built on the `vfs.hot` fd family (`close`/`stat`/`truncate`/`chmod`/`chown`/`utimes`/`datasync`/`sync`/`read`/`readFile`/`write`/`writeFile`/`appendFile`/`Symbol.asyncDispose`), which works over a real VfsBus and the worker sync-channel facade alike.

`process.hrtime(prev)` validates its tuple argument (`ERR_INVALID_ARG_TYPE`/`ERR_OUT_OF_RANGE`) and normalizes the diff borrow so nanoseconds stay non-negative; `process.reallyExit` throws `ProcessExit` without emitting `'exit'` handlers.
