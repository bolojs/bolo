---
tags:
- bolo
- workflow
- plans
---
Working notes for the bolo repo (owner josocjoq).

Plan files live in `.agents/plans/` and are **gitignored** (via `~/.gitignore-global`: `.agents/plans/`), so plan edits never show up in `git status` and are not committed. Same for `.agents/site/`. `.agents/probes/` is untracked but NOT ignored.

The cross-repo decisions log is `/Users/josocjoq/Documents/prjcts/_own/.agents/decisions.md` (one line per decision, format `YYYY-MM-DD | project: decision | reason`). Append decisions there.

Active thread for the WebContainers-parity research: t3 thread `af0eabe4-f250-4cb9-9885-8c46dc0f8a05` ("Adversarial Browser Node.js Runtimes"). The plans it produced: `.agents/plans/2026-11-07-webcontainers-parity-releases.md` (release plan) and `.agents/plans/2026-11-07-release-mechanics-and-verification.md` (mechanics + verification).

Gotcha: the owner-facing T3 runs with codex-plan hit `max_output_tokens` twice mid-write (runs 7 and 8). When resuming a thread whose turn died mid-file, read the plan files first and finish the write rather than re-deriving research.
