# Bolo — Orchestration Handoff (2026-11-18)

Handoff from the laptop session (T3 Code, bifrost/codex-plan). The laptop is being retired; orchestration continues from another device. Three delegated implementation sessions are running on the VPS right now — their outputs land on the VPS and as pushed branches, not here.

One paragraph per line, per house markdown rules.

## Where things stand

Origin main is at `ba65919` (`chore(compat): drop the stale timers expected-fail, refresh node-core results (#211)`). Everything merged and green. Deployed site bolojs.dev is healthy (production deployment `004217a4`, all routes 200 with COOP/COEP headers, verified via playwright on 2026-11-18).

Node-core compat: 156/166 = 94.0%. Lane A (fixable shim work) is empty; all 9 remaining node-test failures are genuine native-binding cases (`internalBinding('os'|'util'|'cares_wrap'|'tls_wrap')`, `js_stream._externalStream`, trace_events, inspector debug port). They are ledgered in `apps/compat-harness/src/expectations.json` and should stay there.

npm package compat: 99 pass / 8 fail / 4 skip of 111. The failures split into: vite (native rolldown binding — being fixed now), jest + webpack + zod + linkedom (bundler-wedge class — being fixed now), yup + semver + sucrase (MISSING_EXPORT / CJS interop class, unassigned), ws (probe quirk, prints SKIP itself), parcel + rspack + turbo (lane C, native, expected-fail forever).

Merged this session: PR #209 (util.types + timers/promises setInterval drain, 8bd15c8), PR #210 (catalog rebuilt as environment cards, d2edf38), PR #211 (compat refresh to 94.0%, ba65919), PR #212 (/probe endpoint, 35c2638). PR #212 documented in `docs/api.md`.

## The three running VPS sessions

All launched 2026-11-18 ~22:30 PST via `harness r own-agents@ovhcloud launch maki bifrost/codex-execute <name> <prompt> --cwd /home/own-agents/src/bolo --box 3 --contract`. Model: bifrost/codex-execute. Verified `WORKING` ~60s after launch (process alive, files being written).

| Session | Goal | Worktree (VPS) | Branch | Output / sentinel | Time box |
|---|---|---|---|---|---|
| bolo-vite-fix | vite probe: alias bare `rolldown` -> same-origin `@rolldown/browser` | `~/src/bolo/.worktrees/vite-probe-fix` | `fix/vite-probe-rolldown` | `/tmp/bolo-vite-fix.out.md` / `.done` / `.progress` | 3h |
| bolo-wedge | diagnose + fix jest, webpack, zod, linkedom bundler wedges | `~/src/bolo/.worktrees/bundler-wedge` | `fix/bundler-wedge-probes` | `/tmp/bolo-wedge.out.md` / `.done` / `.progress` | 3h |
| bolo-preset | `@bolojs/vite-preset` sw.js + `_headers` + dev COI; ADR-0010 host-backed workloads | `~/src/bolo/.worktrees/preset-adr` | `feat/vite-preset-complete` | `/tmp/bolo-preset.out.md` / `.done` / `.progress` | 3h |

None of the three can open PRs (no `gh` on the VPS). Each pushes its branch and writes a ready-to-paste PR title + body into its `.out.md`. PR opening, review, merge and board edits are YOUR job on the orchestrating device.

Non-blocking check recipe: `harness r own-agents@ovhcloud watch` (one read, never a poll loop). Liveness = work product: newest file mtime in the worktree, last commit age, `/tmp/<name>.progress` lines. OK under 20 min idle, QUIET 20-30, STALL over 30, OVERTIME past the 3h box. On STALL: `tmux kill-session -t <name>` by name on the VPS (never `pkill -f`), check the worktree, relaunch in the SAME worktree with a close-out prompt listing only the remaining items. These are oneshot sessions (--box forced it), so they cannot be steered mid-run; steering a oneshot means kill + relaunch.

When a session finishes: read its `.out.md` via `ssh own-agents@ovhcloud cat /tmp/<name>.out.md`, verify the branch exists and is pushed, open the PR from the orchestrating device, link it to the GitHub Project (bolojs/projects/1), and watch it (`watch_pull_request`). After merge: `git -C ~/src/bolo worktree remove <wt>` on the VPS and delete the branch.

## The vite fix design (context for reviewing bolo-vite-fix)

Diagnosed and verified on the laptop before delegation, so you can judge the PR without re-deriving:

- vite 8.3.8 statically imports bare `rolldown` (+ subpaths `/utils`, `/plugins`, `/parseAst`, `/experimental`, `/filter`) from `dist/node/chunks/node.js`. Its declared dep is `rolldown: "~1.2.18"`, a napi-rs native package. No platform binding is installed in the container, so `dist/shared/binding-*.mjs` throws `Cannot find native binding. npm has a bug related to optional dependencies...` at module init.
- The browser build is the separate package `@rolldown/browser` (same public API, `browser` export condition), already a dependency of `packages/wasm-registry` (`^1.3.2`).
- Two dead ends, both verified in-container: (1) inlining `@rolldown/browser` into the bundle fails because the bundle runs from a `blob:` URL and `@rolldown/browser` does `new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url))` -> `TypeError: Invalid URL`; (2) importing it from esm.sh fails with `SecurityError: Failed to construct 'Worker'` because classic workers cannot load cross-origin scripts. This is the same documented problem as `packages/wasm-registry/src/bundle.ts:8-27` and `packages/log/src/error-hints.ts`.
- Verified working: the container can `await import('http://localhost:5199/@fs/<abs-path-to-@rolldown/browser>/dist/index.browser.mjs')` — a real same-origin http URL keeps `import.meta.url` resolvable, the WASI worker constructs, `typeof mod.rolldown === 'function'`.
- So the design is: the host page tells the container's bundler the same-origin URL where it serves `@rolldown/browser`, and `bundle.ts` gains an alias plugin (modeled on `nativeAddonVariantPlugin`, `bundle.ts:1293`) that rewrites bare `rolldown` + subpaths to that URL as an EXTERNAL import, registered before `vfsPlugin`. Hosts that do not provide the URL keep today's esm.sh fallback behaviour. The `apps/compat-harness` host already serves `@rolldown/browser` same-origin (`optimizeDeps.exclude` + `__preferLocalBundler`), so the harness just needs to publish the URL.
- Probe verify loop: build workspace (`flock /tmp/tsc.lock pnpm build`), serve `apps/compat-harness` with vite (COOP/COEP required or the WASM bundler traps), then `node bin/cli.js --url http://localhost:5199 --packages "vite" --output /tmp/x.json`.

## Watch out for

The pre-push hook runs `pnpm validate` (turbo typecheck+lint+format+test across ALL workspaces including the compat-harness build). A single-package `pnpm test` is not enough to push from a laptop checkout; on the VPS the sessions were told about the global `flock /tmp/tsc.lock`.

Shim module default-export trap (bit us in PR #209): when replacing an unenv-backed shim module wholesale, check what unenv's own runtime imports from it. `unenv/dist/runtime/node/util.mjs` does `import types from "node:util/types"` — a default import. A faithful rewrite without a `default` export breaks every consumer bundle (MISSING_EXPORT). Saved in memory as `shim-default-export-trap.md` (this device) — re-derive from the PR if the memory does not travel.

Build gotcha: `packages/runtime/src/node-timers.ts` imports shim sources from `dist/`, so shim edits need `pnpm turbo run build --filter=@bolojs/node-web-shims` before runtime tests see them.

`docs/api.md` is the real file; `apps/site/docs/src/content/docs` is a symlink to `docs/` and `git add` on the symlink path fails ("beyond a symbolic link").

Landing site uses `exactOptionalPropertyTypes: true` — optional props need explicit `| undefined` when assigning undefined.

The compat harness dev server must send COOP/COEP headers (its vite.config.ts already does) or the WASM bundler traps with a bare "unreachable" RuntimeError. Never run the dev server as a bare `&` — use `harness svc run` or a named tmux session; kill by session name only.

`container.spawn` merges stdout AND stderr into one stream (`proc.output`); separate fields by exit code. `node -e <script> -- <arg>` does NOT propagate argv through the shell quoter; inline code via `JSON.stringify` into the -e script. `BrowserContainer` public surface is spawn/mount/evalRepl/fs/events — no `shell` or `version` property. `startRepl()` before `evalRepl()`.

/playwright on this laptop was reconfigured to chromium (`.playwright/cli.config.json`) because msedge is not installed. That file is uncommitted-local config; do not assume it exists elsewhere.

## Untouched backlog (not delegated)

In priority order, with the board issue where known:

1. Review + merge the three VPS branches when they land (that IS the delegated work's follow-through).
2. yup / semver / sucrase MISSING_EXPORT + CJS-interop class (`yup` -> `property-expr` named-export shape; `semver` -> `__bc_cjsNs` reading `undefined.module.exports`; `sucrase` -> oxc transform warnings escalating to errors). Unassigned; same class as the winston/dompurify/tsc default-interop work from plan 2026-11-12.
3. `ws` probe: its browser-field build has no WebSocket export and the probe prints `SKIP: ws browser field ship` — either a lane B entry with an honest reason or a probe rewrite against `node:http`.
4. ADR-0010 implementation (HostBackend/WorkloadTransport) — the ADR itself is being drafted by bolo-preset; implementation is a separate future effort, likely generalizing `apps/tcp-relay/`.
5. Catalog/DX polish: the reference-layouts pass (CodeSandbox / JSFiddle / Hoppscotch / bolt.new) landed the card grid (PR #210); deeper per-subsite work continues per `.agents/plans/2026-11-17-ui-*.md`.
6. Housekeeping on THIS laptop is happening as part of the retirement (see below). The VPS keeps `~/src/bolo` and its worktrees; the stale `delegate/fix-a|c` worktrees were already removed, `delegate/fix-b` remains (2fa9176, no unique commits, dirty:3) and the `npm-fails` worktree holds stash `wip: npm-matrix-fails uncommitted module-shim work (2026-11-18)` (111 lines in `module-shim.ts` + `live.ts`) — keep both until someone triages them.

## GitHub Project and PR discipline

All work links to https://github.com/orgs/bolojs/projects/1. Every PR you create/take over/push gets `link_pull_request` (full URL, one call per PR, every stack layer) as your next tool call after creating it. Watch PRs you are waiting on; `unwatch_pull_request` before handback.

## Local device cleanup (this laptop, after handoff)

Being done as part of retirement; do not repeat blindly on the new device:

- Repo at `/Users/josocjoq/Documents/prjcts/_own/bolo`: cleanup done 2026-11-18 ~22:45 PST. All 64 registered worktrees removed (repo-local `.worktrees/` 2.6G, `~/.worktrees/bolo*` husks, `~/.t3/worktrees/bolo`); uncommitted diffs from five dirty t3 worktrees were archived to `/tmp/bolo-archive/*.diff` before removal (also lost with the device, but small enough to paste from this session log if needed). Branches with commits not in main and not on any remote were preserved as read-only archive refs on origin: `refs/archive/unmerged/feat/dogfood-v0.1.0`, `refs/archive/unmerged/t3/node-compat-fails`, `refs/archive/unmerged/feat/solid-app-builder`, `refs/archive/unmerged/fix/compat-heatmap-svg`. All three local stashes dropped after verifying their content was already in main. `node_modules` (1.0G), all `dist/`, `.turbo/`, `.logs/`, `*.tsbuildinfo` deleted; pnpm store pruned 12G -> 10G; orphaned headless chromium processes killed; playwright cache 2.1G -> 1.1G (kept chromium-1232/1252 + headless shells for other projects on this machine).
- Memory notes were copied into the repo at `.agents/notes/memory-2026-11-18/` (13 notes, including `shim-default-export-trap.md`, `timers-promises-setinterval-semantics.md`, `probe-endpoint-design.md`, `parcel-lane-c.md`, `vps-delegation.md`, `pages-deploy-pinning.md`) and committed to origin/main. Restore them into the new device's project memory (Maki: `~/.local/state/maki/projects/bolo-*/memories/`) or read them straight from the repo.
- T3 Code: this thread ends here. The three VPS sessions are independent of this device — they run under `own-agents@ovhcloud` and only need `harness r own-agents@ovhcloud ...` from any device with ssh access.
- The VPS agent user is `own-agents` (never `debian`); PATH there needs `export PATH=$HOME/.local/share/mise/shims:$PATH`. No `gh` on the VPS: open PRs from the orchestrating device only.
