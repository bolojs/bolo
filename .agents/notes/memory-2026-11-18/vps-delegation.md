---
tags:
- bolo
- workflow
---
# VPS delegation for bolo

VPS: `own-agents@ovhcloud` (26G free on 99G disk, 11G RAM, 7G available). Clone at `~/src/bolo`, worktrees under `~/src/bolo/.worktrees/`. pnpm 10.26.1, node v24.22.1, `gh` CLI IS installed and authenticated as `espetro` (so VPS can open PRs too).

## Running an agent on the VPS

```bash
harness launch codex codex-execute <session> <prompt-file> --cwd <worktree-abs-path> --box 3 --contract
```

Models available (bifrost catalog): `codex-plan`, `codex-execute`, `codex-free`, `zai-coding-plan/glm-5.x`, `minimax-coding-plan/MiniMax-M*`, `kimi-for-coding/k3`.

Monitor: `/tmp/<session>.progress`, `/tmp/<session>.log`, `/tmp/<session>.done` sentinel, `/tmp/maki/<session>.out.md` final report. `harness ls` is BROKEN on this box (traceback in harness/cli.py ls_rows) — use the /tmp files directly instead.

## Setup already done (2026-11-17)

- `pnpm config set packageImportMethod hardlink --global` on the VPS so worktrees hardlink from the shared store at `~/.local/share/pnpm/store/v11` (5.9G).
- Three delegated worktrees created off `origin/feat/npm-interop-sweep`:
  - `delegate-a` branch `delegate/fix-a` — vite probe (esbuild native binding)
  - `delegate-b` branch `delegate/fix-b` — jest probe (unrs cross-origin Worker)
  - `delegate-c` branch `delegate/fix-c` — 4 unexpected node-core test failures
- Subagents: commit locally, never push, never open PRs (coordinator does it).

## Gotchas

- `harness launch` needs an absolute `--cwd`; `~` is not expanded inside the remote command.
- One vite dev server per worktree. Ports 5173/5174/5176 collide across worktrees. Check the server log to confirm which worktree it serves.
- The VPS cannot run the real browser harness easily; agents use the vite dev server + headless chromium (playwright chromium-1228 is in ~/.cache/ms-playwright).
