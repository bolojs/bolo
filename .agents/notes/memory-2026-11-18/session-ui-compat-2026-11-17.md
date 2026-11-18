---
tags:
- bolo
- session
- ui
---
# Session: UI terminal E2E fix + workbench Phase B (2026-11-17)

## Landed this session
- **PR #205 MERGED** — terminal glyph metrics + panel chrome. Its E2E failure was NOT the font gate: `.xterm-rows` only holds the visible viewport (~9 rows at 720p), so `cat package.json` line 1 ("name") scrolled out of the DOM. Fix: hidden `[data-terminal-buffer]` div mirrors the full ANSI-stripped stream (last 100KB); `terminalOutputContains` step checks buffer first. Commit a321b92 (write queueing) + b226b46 (mirror).
- **PR #206 MERGED** — workbench shell Phase A (/ide migration). Extracted `subsites/shared/preview-servers.ts` + `subsites/workbench/` (WorkbenchShell, ActivityRail, TabStrip, BottomPanel, StatusBar, tabs.ts, types.ts).
- **PR #207 OPEN** (branch `feat/vibe-workbench`) — Phase B: `/vibe` → VibeWorkbench.tsx (chat sidebar + pinned Preview tab + terminal bottom panel); `/app` → AppWorkbench.tsx (routes sidebar, request + code tabs in strip, response viewer folded into request tab, terminal bottom panel); deleted shared `SubsiteApp.tsx`. Full E2E green locally (10 specs/28 scenarios). Watching CI.

## Gotchas learned
- Workbench tabs: hidden tab bodies (`hidden` class) aren't clickable — e2e specs must activate a tab before driving its contents (`I activate the "<title>" tab` step in app-steps.ts).
- Import depth: `subsites/app/*.tsx` → `../../demo/client-globals` (3 levels), `subsites/vibe/components/*` → `../../../demo/client-globals` (4 levels).
- Workbench elements built inside conditional branches get disposed with the branch — use `runWithOwner(getOwner(), ...)` for one-shot shared Editor/chat elements (pattern in IdeApp/AppWorkbench/VibeWorkbench).
- Local E2E: `cd apps/site/landing && pnpm exec astro dev --port 4321` (background), then `cd tests/e2e && gauge run specs --tags='!wip'`. Full suite ~2min.
- tsc on landing takes >5min under flock — run in background.
- Chip Marquee pauses on hover+wheel; chips clicked via `getByRole('button', {name})`.

## Compat lanes status (from gh PR list)
Merged: #152,#153,#154,#155(expected-fail ledger=W5),#156,#157,#162,#166 → W1/W2/W5 largely done. Remaining: W4 (#149 implicit wasm addon discovery). Verify current matrix scores from latest nightly before new compat work.

## Next
- Merge #207 when CI green (watching).
- Then check compat matrix scores; W4 #149 is the remaining known compat unit.
