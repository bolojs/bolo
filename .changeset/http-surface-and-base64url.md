---
"@bolojs/node-runtime-shims": minor
"@bolojs/node-web-shims": minor
---

Implement full `node:http` surface (`METHODS`, `STATUS_CODES`, `Server` constructor callable with/without `new`, `OutgoingMessage`, `maxHeaderSize`, `validateHeaderName`, `validateHeaderValue`, `setMaxIdleHTTPParsers`), complete virtual module exports for `node:fs`, `node:fs/promises`, `node:http`, `node:https`, `node:net`, `node:child_process`, `node:dns`, and `node:vm` in `nodeRuntimeShims` Vite plugin, support transparent `base64url` encoding across `Buffer.isEncoding`, `Buffer.from`, `Buffer.prototype.toString`, `Buffer.prototype.write`, and `Buffer.byteLength`, and make `vm.runInNewContext`, `vm.runInContext`, and `vm.createContext` synchronous.
