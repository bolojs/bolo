---
tags:
- bolo
- workflow
---
# Codex sandbox network on VPS

Codex `exec` sessions run with `-s workspace-write` (hardcoded in harness-lib tools.py line 61), and codex's workspace-write sandbox blocks network by default. This caused a false "BLOCKED: no network" verdict from the jest agent on 2026-11-17 (network was fine; only the sandbox was blocking).

**Fix applied**: appended to `~/.codex/config.toml` on own-agents@ovhcloud:
```toml
[sandbox_workspace_write]
network_access = true
```
Verified with `codex exec -s workspace-write` + curl → 200.

**Note**: sessions already running when the config changed may still be blocked — relaunch instead of steering repeatedly. Also: when the base branch moves (e.g. PR merges), reset delegated worktrees with `git reset --hard origin/main` (they're fork-based branches tracking origin/feat/*).

**PR #208 merged** at 2026-11-17T23:11Z as squash commit `2fa9176` on main. Branch `feat/npm-interop-sweep` NOT deleted locally (delete-branch=false); local worktree `.worktrees/npm-interop` still has the branch checked out.
