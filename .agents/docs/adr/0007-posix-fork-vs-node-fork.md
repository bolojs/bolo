# ADR-0007: POSIX fork vs Node child_process.fork()

## Status

Accepted, 2026-07-17

## Context

The PRD's Tier-4 table lists `fork()` with the rationale "no shared memory (CoW) between Workers". This wording is imprecise and conflates two distinct APIs.

## Decision

Distinguish the two forks explicitly.

- **POSIX `fork(2)`** is a Tier-4 hard limit. It cannot be emulated in a browser. V8 exposes no heap-snapshot/clone API, there is no MMU page-table access for copy-on-write semantics, and there are no resumable continuations across isolates. `SharedArrayBuffer` is shared memory, the opposite of CoW, so it cannot substitute.

- **Node `child_process.fork(modulePath)`** is a Tier-3 emulable API. It is a different abstraction: it spawns the given module in a new Worker with an IPC message channel. bolo implements it in `packages/node-runtime-shims/src/child-process-shim.ts` via `WorkerChildProcessImpl`.

## Consequences

- The PRD Tier-4 rationale is updated to precise wording (done in parallel under issue #25).
- The `FORK_NOT_SUPPORTED` error message in the child-process shim must distinguish POSIX fork from Node's `fork()` and reference this ADR (tracked under issue #26).
- Future "can we fork?" questions route here first.
