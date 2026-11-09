---
"@bolojs/runtime": minor
"@bolojs/node-runtime-shims": minor
"@bolojs/node-web-shims": minor
"@bolojs/sandbox": minor
---

Process model: every Node process now runs in its own Worker.

- Worker-per-process spine with remote dependency loading and a synchronous worker-main channel (SharedArrayBuffer plus sync XHR through the service worker).
- Real `kill()`: terminating a process tears down its worker and handles.
- Faithful exit codes: `process.exit()` is uncatchable, uncaught crashes run `exit` handlers and report a non-zero code, and output is gated after exit.
- Event-loop liveness: handle-tracked timers and servers keep a process alive until idle, with `process.nextTick` queue and macrotask `setImmediate` semantics matching Node.
