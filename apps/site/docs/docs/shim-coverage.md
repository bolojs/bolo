---
title: Node.js Shim Coverage
description: Implementation status of the built-in node:* shims.
---

| Module | Package | Status | Notes |
|--------|---------|--------|-------|
| `node:crypto` | node-web-shims | Implemented | WebCrypto via unenv |
| `node:stream` | node-web-shims | Implemented | WebStreams via unenv |
| `node:buffer` | node-web-shims | Implemented | ArrayBuffer/Uint8Array via unenv |
| `node:path` | node-web-shims | Implemented | path-browserify via unenv |
| `node:url` | node-web-shims | Implemented | URL/URLSearchParams via unenv |
| `node:events` | node-web-shims | Implemented | EventEmitter via unenv |
| `node:os` | node-web-shims | Implemented | Minimal stub via unenv |
| `node:http` (client) | node-web-shims | Implemented | fetch adapter via unenv |
| `node:worker_threads` | node-web-shims | Implemented | Minimal wrapper around threads.js |
| `node:util` | node-web-shims | Implemented | `promisify`/`inherits`/`types`/format via unenv |
| `node:async_hooks` | node-web-shims | Implemented | `AsyncLocalStorage`/`AsyncResource` via unenv |
| `node:querystring` | node-web-shims | Implemented | `parse`/`stringify`/`escape`/`unescape` via unenv |
| `node:fs` | node-runtime-shims | Implemented | VfsBus — async ops, sync throws |
| `node:fs/promises` | node-runtime-shims | Implemented | VfsBus promises namespace |
| `node:http` (createServer) | node-runtime-shims | Implemented | VirtualServer via sw-sandbox |
| `node:net` (createServer) | node-runtime-shims | Implemented | Delegates to createHttpShim |
| `node:child_process` | node-runtime-shims | Implemented | WASM registry + ShellService fallback |
| `fs.watch` / `chokidar` | node-runtime-shims | Implemented | VfsBus.watch() |
| Shell commands (pipes, redirection, quoting) | runtime | Implemented | `just-bash` interpreter backed by `VfsBashFileSystem` (VfsBus) |
| `wasm32-wasip1` CLI binaries | wasm-registry | Implemented | Generic `createWasiTool()` loader via `@bjorn3/browser_wasi_shim`, VfsBus-backed preopens — filesystem + args/env only, no sockets/threads/fork (WASIX) |
