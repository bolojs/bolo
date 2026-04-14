# Node.js Shim Coverage

| Module | Package | Status | Notes |
|--------|---------|--------|-------|
| `node:crypto` | node-web-shims | Planned | WebCrypto via unenv |
| `node:stream` | node-web-shims | Planned | WebStreams via unenv |
| `node:buffer` | node-web-shims | Planned | ArrayBuffer/Uint8Array via unenv |
| `node:path` | node-web-shims | Planned | path-browserify via unenv |
| `node:url` | node-web-shims | Planned | URL/URLSearchParams via unenv |
| `node:events` | node-web-shims | Planned | EventEmitter via unenv |
| `node:os` | node-web-shims | Planned | Minimal stub via unenv |
| `node:http` (client) | node-web-shims | Planned | fetch adapter via unenv |
| `node:worker_threads` | node-web-shims | Planned | threads.js |
| `node:fs` | node-runtime-shims | Planned | VfsBus |
| `node:fs/promises` | node-runtime-shims | Planned | VfsBus |
| `node:http` (createServer) | node-runtime-shims | Planned | VirtualServer via sw-sandbox |
| `node:net` (createServer) | node-runtime-shims | Planned | VirtualServer via sw-sandbox |
| `node:child_process` | node-runtime-shims | Planned | WASM registry + ShellService |
| `fs.watch` / `chokidar` | node-runtime-shims | Planned | VfsBus.watch() |
