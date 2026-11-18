---
tags:
- bolo
- workflow
---
# Disk + delegation notes (2026-11-17, from user)

## Problem
- Mac disk at 96% (9.3Gi free of 228Gi). Each bolo worktree's node_modules is ~1.0–1.1G; main repo is 1.0G; three active bolo worktrees ≈ 3.2G just in node_modules.
- pnpm global store `~/Library/pnpm/store/v11` is 12G total: `files/` 1.7G (the real CAS, hardlinked into projects), but `links/` 11G (per-package extracted copies, notably `@scriptc` 3.7G — pyscriptc's binaries) and `index.db` 34M.
- VPS `own-agents@ovhcloud`: 99G disk, 26G free, bolo clone at `~/src/bolo`, worktrees under `~/src/bolo/.worktrees/`, pnpm store `~/.local/share/pnpm/store/v11`. No `gh` on VPS (PRs from laptop).

## User decisions
1. Worktrees/agents must share the global pnpm store, not duplicate installs. bolo uses pnpm 10 (packageManager pnpm@10.26.1), bun 1.3.14 available but not used for installs. brioso's model (`.agents/docs/worktree-disk-budget.md` + `scripts/worktree-init.sh`): keep worktree-local node_modules (hoisted linker) but rely on the global content-addressable store so file content is shared via hardlinks — the cost per worktree is mostly the filesystem entries, not new content. brioso rejected `virtualStoreType: global` because pnpm's `verifyDepsBeforeRun` / `.modules.yaml` is workspace-rooted and cross-worktree global installs pollute each other.
2. Delegate implementation work to the VPS (`harness r own-agents@ovhcloud launch ...`), not locally. Laptop is short on CPU/RAM/disk and its network is unreliable. Placement rule: implementation sessions on VPS; research/orchestration on laptop.

## Facts
- bolo pnpm-workspace.yaml has no nodeLinker setting (default isolated layout with .pnpm virtual store; packages ARE hardlinked from the store when versions match — check with `stat -f "%i %l"`; links=1 means a fresh copy, links>1 means shared).
- Old worktree node_modules from stale branches are prime deletion targets: `rm -rf .worktrees/<name>/node_modules` then `pnpm store prune` reclaims orphaned store files.
- The brioso worktree-init pattern: copy `pnpm-workspace.yaml` from main checkout into the worktree before install (worktrees on old branches may lack it; pnpm doesn't walk up across worktree boundaries).
