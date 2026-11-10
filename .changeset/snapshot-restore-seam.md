---
"@bolojs/runtime": minor
---

Add optional `snapshot()`/`restore()` to `SandboxBackend` with a `supportsSnapshots()` type guard, plus `container.checkpoint()` / `boot({ resume })` for session-local VFS+backend checkpoints and warm starts. Backwards-compatible: `IframeSandbox` and existing backends remain valid without changes.
