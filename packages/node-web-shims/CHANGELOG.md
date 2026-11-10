# @bolojs/node-web-shims

## 0.3.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

- [#81](https://github.com/bolojs/bolo/pull/81) [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62) Thanks [@espetro](https://github.com/espetro)! - Process model: every Node process now runs in its own Worker.

  - Worker-per-process spine with remote dependency loading and a synchronous worker-main channel (SharedArrayBuffer plus sync XHR through the service worker).
  - Real `kill()`: terminating a process tears down its worker and handles.
  - Faithful exit codes: `process.exit()` is uncatchable, uncaught crashes run `exit` handlers and report a non-zero code, and output is gated after exit.
  - Event-loop liveness: handle-tracked timers and servers keep a process alive until idle, with `process.nextTick` queue and macrotask `setImmediate` semantics matching Node.

## 0.2.0-rc.0

### Minor Changes

- [#81](https://github.com/bolojs/bolo/pull/81) [`397f780`](https://github.com/bolojs/bolo/commit/397f780cad0348a5564d46f706045256bda93c17) Thanks [@espetro](https://github.com/espetro)! - Initial public release.

- [#81](https://github.com/bolojs/bolo/pull/81) [`f444253`](https://github.com/bolojs/bolo/commit/f44425329d9f7c1dc7025effb3a2e88dd74b0a62) Thanks [@espetro](https://github.com/espetro)! - Process model: every Node process now runs in its own Worker.

  - Worker-per-process spine with remote dependency loading and a synchronous worker-main channel (SharedArrayBuffer plus sync XHR through the service worker).
  - Real `kill()`: terminating a process tears down its worker and handles.
  - Faithful exit codes: `process.exit()` is uncatchable, uncaught crashes run `exit` handlers and report a non-zero code, and output is gated after exit.
  - Event-loop liveness: handle-tracked timers and servers keep a process alive until idle, with `process.nextTick` queue and macrotask `setImmediate` semantics matching Node.
