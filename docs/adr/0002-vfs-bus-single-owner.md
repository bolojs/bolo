# ADR-0002: VfsBus Single-Owner Architecture

## Status

Accepted

## Context

Previous iterations used multiple memfs instances shared across packages (VFS, npm, runtime, vite-worker). This caused synchronization bugs: writes to one instance were invisible to others, file watches fired inconsistently, and concurrent package installs could corrupt state.

The root cause was shared mutable state with multiple writers and no coordination protocol.

## Decision

Adopt a single-owner VFS architecture via `@browser-containers/vfs-bus`:

- **One VfsBus instance** (singleton via `vfsRegistry`) is shared by all consumers.
- **Single write authority**: Only `VfsController` on the main thread may write. All other consumers receive read-only views or go through VfsController's API.
- **Two-layer storage**: Hot layer (memfs in RAM) for active files, cold layer (OPFS) for installed packages and build cache.
- **Observable mutations**: Write/delete/rename events notify all subscribers. Watch via glob patterns provides chokidar-compatible API for Vite HMR and shim file watchers.
- **ACL middleware**: `bus.use(middleware)` hook enforces sandbox-policy filesystem restrictions (read-only, path allowlists).

This eliminates sync bugs by construction — there is only one source of truth and one write path.
