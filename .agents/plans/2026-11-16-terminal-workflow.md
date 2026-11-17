# Terminal workflow across catalog subsites

Date: 2026-11-16. Status: research + plan only, no feature code.
Scope: `/sandbox`, `/ide`, `/app`, `/vibe` under `apps/site/landing/src/subsites/`, plus the runtime command surface they reach (`packages/runtime/src/shell-service.ts`, `process.ts`, `repl-service.ts`).

## 1. Findings

### 1.1 Terminal component (`apps/site/landing/src/subsites/ui/Terminal.tsx`)

Real xterm.js (`@xterm/xterm@^6`) with only `FitAddon` loaded (`Terminal.tsx:74-75`); `apps/site/landing/package.json:36-37` has no web-links, webgl, search, or serialize addons. Everything else is a hand-rolled line editor on `xterm.onData` (`Terminal.tsx:109-145`):

- Supported keys: Enter, Backspace, ArrowUp/ArrowDown history. Nothing else.
- No left/right cursor movement, no Ctrl+A/E/U/K/W editing, no Ctrl+L clear, no Ctrl+D EOF, no Ctrl+C interrupt (`\x03` and other control bytes fall through the `data >= " "` check at `Terminal.tsx:141` and are silently dropped).
- No tab completion (`\t` is appended verbatim to `lineBuffer`, `Terminal.tsx:141-144`).
- History is a volatile local array (`Terminal.tsx:21`), wiped on unmount and whenever `props.lines` shrinks (`Terminal.tsx:150-156`). No dedup, no persistence. `ReplService` already persists REPL history to `/home/web/.node_repl_history` (`repl-service.ts:4`, `loadHistory`/`appendHistory` at `repl-service.ts:42-59`), but the shell side has nothing equivalent and the REPL terminal does not load that file into its arrow-key history either.
- Paste: multi-line paste delivers `\r` per line, so each pasted line auto-submits (`Terminal.tsx:112-113`). No bracketed-paste handling, no confirmation.
- Prompt is the hardcoded string `"> "` / `"... "` written by the component (`Terminal.tsx:104`). The real-looking prompt is faked by callers appending a dim `\x1b[2m~/project $ cmd\x1b[0m` echo line (`SubsiteApp.tsx:172`, `SandboxApp.tsx:98`, `Demo.tsx:85`), so every command appears twice: once as the typed line, once as the dim echo.
- `disabled` swallows keystrokes with zero feedback (`Terminal.tsx:110`).
- Submissions serialize on a `pending` promise (`Terminal.tsx:87-107`). While a long-running command (e.g. `node server.js`) is in flight, typed lines are accepted but queued with no visual indication.

### 1.2 Subsite wiring

- `SubsiteApp.tsx` is shared by `/ide` and `/vibe` (PANELS map, `SubsiteApp.tsx:67-71`); `/sandbox` has its own richer `SandboxApp.tsx` (script/REPL tabs + example chips); `/app` has **no terminal at all** (`AppSubsite.tsx` imports no `Terminal`, it is a route/client workbench only).
- Every consumer duplicates the same submit pipeline: split on `/\s+/`, special-case bare `node` → `container.startRepl()`, `runToCompletion(container.spawn(command, args))`, append `exit N` (`SubsiteApp.tsx:201-214`, `IdeApp.tsx:169-182`, `SandboxApp.tsx:94-101`, `Demo.tsx:82-88`). REPL-entry logic is copy-pasted in three places.
- Boot install discards the real exit code: `appendLine("\r\n\x1b[2mexit 0\x1b[0m\r\n")` is hardcoded after `npm install` (`SubsiteApp.tsx:151-152`, `IdeApp.tsx:256-257`).
- Quoting is broken for routed builtins: the UI splits on whitespace, `createProcess` re-joins with plain spaces (`process.ts:56`), then `route()` re-splits (`shell-service.ts:295`). `git commit -m "hello world"` arrives at the git builtin as two args `"hello` `world"`. Pipes/redirects work only for commands that fall through to `just-bash`; a pipe after `git`, `node`, `npm`, `curl` becomes literal argv to the builtin.
- stderr and stdout are merged into one stream in `createProcess` (`process.ts:56-59`, both callbacks enqueue to the same controller). The terminal cannot color errors; `ShellResult` keeps them separate internally (`shell-service.ts:72-76`) but the Process API drops the distinction.
- `SpawnOptions` has `cwd`, `env`, `timeout`, `httpShimOptions` only; `Process` is `{ exit, output, kill }` (`container-types.ts:106-117`). No stdin, no `terminal: {cols, rows}`, no `resize`. This is already a declared WebContainers-parity gap (`.agents/plans/2026-11-07-webcontainers-parity-releases.md:83`).
- No consumer ever calls `proc.kill()` — there is no interrupt path anywhere in `subsites/` or `demo/` (grep for `kill`/`\x03` returns nothing). A `node server.js` or hung script can only be abandoned by reloading the page.

### 1.3 ShellService command surface (`packages/runtime/src/shell-service.ts`)

Routed before just-bash, in `route()` (`shell-service.ts:294-345`):

| Command | Handling | Gaps |
|---|---|---|
| `node`, `bun` | `--version`/`-v` print `BOLO_NODE_VERSION`; bare → `routeRepl`; else `runNodeApp(file)` (`:308-319`) | `node -e`, `node --eval`, `node --help`, `node -` are treated as file paths → opaque bundler ENOENT. Bare `bun` opens the Node REPL. |
| `npm` | `install`/`i`, `run` only (`:362-382`) | everything else → `Unsupported npm subcommand: X` with no trailing newline and no hint of what IS supported (`:367`). `npm --help`, `npm test`, `npm exec`, `npm create` all hit that wall. |
| `npx` | — | not routed at all → falls to just-bash → `bash: npx: command not found` (127). |
| `runtime` | `run <script>` (`:416-431`) | internal command surfaced raw; unknown subcommands get a bare message, no usage list. |
| `agent` | `run <script>` (`:739-772`) | same; fails "No sandbox configured" when backend absent. |
| `curl`, `git`, `nc`, `tcping` | custom builtins (`commands/`) | unknown `--help` support; `git` is isomorphic-git subset. |
| `sleep` | `routeSleep` (`:352-360`) | shadows just-bash's own `sleep` builtin — dead duplication. |
| wasm tools | `wasmRegistry.dispatch` (`:328-336`) | invisible to users; not listed anywhere. |
| everything else | `just-bash` `Bash.exec` (`:340-344`) | gets the full raw command string, so pipes/quotes DO work here. |

Key discovery: `just-bash@3.1.0` (`packages/runtime/package.json:26`) already ships `help`, `history`, `clear`, `compgen`/`complete`/`compopt`, `which`, `jq`, `yq`, `python3`, `sqlite3`, `rg`, `tree`, `timeout`, `tar`, `gzip` and more, and every builtin supports `--help` (see `node_modules/just-bash/dist/interpreter/builtins/`). They all work today via the fallthrough, but:

- just-bash `help` lists only bash builtins; it has never heard of `node`, `npm`, `git`, `curl`, `runtime`, `agent`, or the wasm tools. Discoverability of the bolo-specific surface is exactly zero.
- just-bash `history` is useless: each `exec()` is isolated (`shell-service.ts:338-340` restores cwd per call), so its history file is always empty. Real history lives only in `Terminal.tsx`'s volatile array.
- just-bash `clear` emits ANSI clear, which xterm renders, but the `lines` model keeps scrollback — works visually, inconsistent state.
- `routeRepl` prints `REPL started. (streaming integration post-v1)` (`shell-service.ts:433-437`) — a stub; consumers never reach it because they intercept bare `node` first and call `container.startRepl()` themselves.

### 1.4 `node` UX gaps

- Bare `node`: works in `/sandbox` (REPL tab), `/ide`, `/vibe` via the duplicated `startRepl`/`evalRepl` path — but the in-shell path (`routeRepl`) is a stub that just prints a message, so `node` behaves differently depending on which layer sees it.
- `node file.js`: bundled via `bundleEntry` with a 30s ceiling (`BUNDLE_TIMEOUT_MS`, `shell-service.ts:136`), then run in a process worker when `Worker` + sync server exist (`:683-689`) with real exit codes, else main-realm `superviseRun`. Errors land on stderr + exit 1 (`:732-736`) but merge into the single output stream.
- `node server.js` (stays alive): `proc.exit` never resolves, `runToCompletion` waits forever, the `pending` queue in Terminal swallows all later input, and there is no interrupt. The only escape is page reload.
- stderr/stdout: merged, see 1.2.

### 1.5 Observability

`shell-service.ts` has zero `@bolojs/log` imports — no logging of command, exit code, duration, or routing decisions. `node-process.ts` logs only worker errors and missed heartbeats (`node-process.ts:13`, `:170`, `:240`). Subsites log only boot/REPL failures (`SubsiteApp.tsx:162`, `SandboxApp.tsx:173`). Shell activity is invisible in `.logs/latest.jsonl`.

### 1.6 Prior context already in repo

- `.agents/plans/2026-11-09-competitive-research-dx-agents.md:63`: "Terminal: ship an xterm.js adapter with resize and a real pty-like line discipline so interactive CLIs (vite prompts, npm init) work." — still unimplemented.
- `.agents/plans/2026-11-07-webcontainers-parity-releases.md:83`: declares `process.input`, `process.resize`, `spawn(..., {terminal})` gaps; `:123` sketches a `@bolojs/ui` kit with an xterm terminal wired to spawn+resize.
- `.agents/plans/2026-11-14-catalog-subsites.md` (/sandbox row): "needs terminal-first UX, better process control (interrupt, timeouts)".
- `docs/internal/references/` does not exist; the bolt.diy/StackBlitz findings live in the two plan docs above. `docs/internal/process-divergences.md` and `package-managers.md` are adjacent reading.

## 2. Proposed command surface

Ordering principle: bolo builtins route first (as today), each gains `--help`; a bolo-aware `help` aggregates everything and delegates to just-bash for bash builtins.

| Command | Behavior |
|---|---|
| `help` | New builtin, routed before just-bash. No args → grouped list: bolo commands (node, npm, git, curl, nc, tcping, sleep, runtime, agent), wasm tools (from `wasmRegistry` descriptors), plus "80+ bash builtins via just-bash — `help <cmd>` or `<cmd> --help`". `help <just-bash cmd>` → pass through to just-bash help. |
| `<builtin> --help` | Every routed command prints usage + supported subcommands instead of `Unsupported npm subcommand: --help`. Fixes `npm --help`, `node --help`, `git --help` uniformly. |
| `node` | Add `-e`/`--eval` (eval a string via the worker eval path used for `WORKER_EVAL_PRELUDE`), `--help` usage, and a clear error for unsupported flags instead of treating them as filenames. |
| `npx` | Minimum: a named error ("npx is not supported yet; install the package then run `node node_modules/.bin/<x>` or use a wasm tool"). Better: resolve `node_modules/.bin` + wasmRegistry dispatch. Decide in implementation PR. |
| `clear` | Add Ctrl+L in the line editor; keep just-bash `clear` but also reset the `lines` model so scrollback state stays consistent. |
| `history` | Real implementation: persist shell history to a VFS file (e.g. `/home/web/.bolo_history`), append on submit, make `history` a routed builtin that prints it. Works from both the terminal UI and spawned shells. |
| Tab completion | Two tiers: (a) client-side: complete builtin names + filenames via `container.fs` readdir; (b) richer: `compgen -c`/`-f` through a throwaway `bash.exec`. Start with (a). |
| Ctrl+C | Interrupt running process: keep the `Process` handle in the subsite, `\x03` in Terminal → `onInterrupt` → `proc.kill()` + `^C` echo + fresh prompt. |
| Ctrl+D | Empty line → exit REPL (when active) or print a hint; non-empty → delete char. |
| `exit` | Exit REPL; in shell print a "closes with the page" hint or ignore politely. |

## 3. UI/UX gap list, ranked by impact / effort

| # | Gap | Impact | Effort | Evidence |
|---|---|---|---|---|
| 1 | No interrupt (Ctrl+C / kill unreachable) — hung `node` bricks the terminal | Critical | M | `Terminal.tsx:141`, `process.ts:112-123` (kill exists, unused) |
| 2 | No `help`/discoverability; `--help` mishandled on every routed builtin; `npx` 127s opaquely | High | S | `shell-service.ts:308-319, 367` |
| 3 | Line editor: no cursor movement, word ops, Ctrl+L/D; tab is a literal char | High | M | `Terminal.tsx:109-145` |
| 4 | Quoting broken for routed builtins (`git commit -m "a b"` splits) | High | S | `SubsiteApp.tsx:207` → `process.ts:56` → `shell-service.ts:295` |
| 5 | stderr indistinguishable from stdout | Medium | M | `process.ts:56-59` |
| 6 | History volatile; `history` builtin prints nothing | Medium | S | `Terminal.tsx:21`, just-bash per-exec isolation |
| 7 | Queued input during long commands gives no feedback; double-echo prompt | Medium | S | `Terminal.tsx:87-104`, callers' dim echo |
| 8 | No clickable links (port URLs, file paths); no webgl renderer | Medium | S | `Terminal.tsx:74-75`, `package.json:36-37` |
| 9 | No stdin/pty (`process.input`, `terminal:{cols,rows}`, `resize`) — interactive CLIs impossible | Medium now, high later | L | `container-types.ts:106-117` |
| 10 | Multi-line paste auto-submits each line | Low-Med | S | `Terminal.tsx:112-113` |
| 11 | Boot install prints hardcoded `exit 0` | Low | XS | `SubsiteApp.tsx:151-152`, `IdeApp.tsx:256-257` |
| 12 | `/app` has no terminal at all | Product decision | — | `AppSubsite.tsx` |
| 13 | Bare `bun` opens the Node REPL; `routeRepl` is a stub | Low | XS | `shell-service.ts:308-311, 433-437` |
| 14 | Zero shell observability in `@bolojs/log` | Medium (debuggability) | S | `shell-service.ts` has no logger |

## 4. Phased implementation plan

Each phase is an independently mergeable PR. Order optimizes user-visible wins first; only P6 depends on earlier phases.

### P1 — Command surface hygiene (runtime only)

- New `help` builtin in `shell-service.ts` routed before just-bash: grouped bolo/wasm/just-bash listing; `help <cmd>` delegates.
- `--help` (and `-h`) handled on every routed builtin (`npm`, `node`, `git`, `curl`, `nc`, `tcping`, `sleep`, `runtime`, `agent`) with a real usage string.
- `npx`: named unsupported-error (fast) or `.bin` resolution if cheap.
- Fix `Unsupported npm subcommand` missing newline; normalize error output to end with `\n`.
- `node -e`/`--eval` via the eval prelude path; `node --help`; clear "unsupported flag" errors.
- Remove `routeSleep` duplication or keep with a comment justifying why (it exists for `child_process` spawns per `:347-351`; document).
- Tests: extend `shell-service` vitest coverage. No UI changes.

### P2 — Interrupt + process control (landing + runtime seam)

- Keep the in-flight `Process` handle in each subsite (`runCommand` already has it in scope).
- `Terminal.tsx`: `\x03` → `onInterrupt` prop → `proc.kill()`, echo `^C`, return prompt. Optional "stop" affordance for touch users.
- Surface queued-input state while a command runs (dim indicator or blocked-input styling).
- Fix hardcoded `exit 0` after boot install to print the real code.

### P3 — Line editor + history (landing only)

- Left/right arrows + cursor-indexed `lineBuffer` (erase/redraw instead of `\b \b` tail-only).
- Ctrl+A/E/U/K/W/L/D; dedup consecutive history entries.
- Persist history to `/home/web/.bolo_history` via `container.fs`; load on mount; REPL loads `.node_repl_history` via `container.getHistory`-equivalent (`ReplService.getHistory()` exists, `repl-service.ts:38`).
- Bracketed paste / multiline-paste confirmation.
- De-dupe the REPL-entry + runCommand pipeline out of the three consumers into a shared hook in `subsites/shared/`.

### P4 — Terminal addons + stderr coloring (landing + runtime seam)

- Add `@xterm/addon-web-links` (port URLs clickable), `@xterm/addon-search`; evaluate `@xterm/addon-webgl` behind a flag.
- stderr separation: smallest honest change is a tagged-chunk output (`{stream:"stdout"|"stderr", data}`) or a second `ReadableStream` on `Process`; terminal writes stderr in `danger` color. `ShellResult` already splits them — the loss is only at `process.ts:56-59`.

### P5 — Completion + `history` builtin (runtime + landing)

- `history` routed builtin reading the VFS history file (lands after P3's persistence).
- Tab completion client-side: builtin names + `fs` path completion; optional `compgen` fallback later.

### P6 — Pty-shaped process API (runtime, largest)

Per `.agents/plans/2026-11-07-webcontainers-parity-releases.md:83` and competitive-research `:63`: `SpawnOptions.terminal {cols,rows}`, `Process.input: WritableStream`, `Process.resize()`. Then Terminal can attach onData → input, drop the hand-rolled echo, and interactive CLIs (`npm init`, vite prompts, git auth prompt planned in `2026-07-19-git-terminal-compat.md:84`) become possible.

### P7 — Observability (runtime, any time)

- `getLogger(["bolo","runtime","shell"])` in `shell-service.execute`: log command, route decision (builtin/wasm/just-bash), exit code, duration; warn-level on unsupported-subcommand paths so complaint reports carry data.

### P8 — Product decision: `/app` terminal + embed kit

- Decide whether `/app` gains a terminal panel (the other three share one component) or stays a pure API workbench.
- Longer term: extract the finished Terminal+pipeline into the `@bolojs/ui` embed kit sketched at parity-releases `:123`.

## 5. Sequencing suggestion

P1 → P2 → P3 → P4 → P5, with P7 inserted anywhere and P6 as its own milestone (it subsumes much of P3's editor once stdin exists). P1+P2 alone fix the two loudest complaints: no `help` and no way to stop a hung `node`.
