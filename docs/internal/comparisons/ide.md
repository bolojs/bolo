# bolo /ide vs web IDE alternatives

Date of test: 2026-11-14. Branch checkout of bolo at `ba92856` (landing dev server, `astro dev`, not a production build).
Author: research sub-agent. Method: official docs and public pages for the matrix, a real headless Chromium (playwright-cli) for the usability log.

## Scope and assumptions

bolo `/ide` is the Solid workbench in `apps/site/landing/src/subsites/ide/IdeApp.tsx`: file tree, CodeMirror 6 editor, preview iframe, command terminal.
It offers two templates: Vite + React (in-browser Vite server) and Next.js Pages Router (emulated by `NextDevServer`, no real `next` binary).
Free, no-login tiers only. No accounts were created and no credentials entered.
Cloudflare or bot walls were not bypassed; where a product blocked an automated browser it is logged as "not tested" with the evidence.
Matrix cells for products that were not exercised come from public docs and prior knowledge and are marked `(unverified)` where I could not confirm them on the date above.
Boot times are single runs on one machine and network. Treat them as order of magnitude, not benchmarks.
Excluded with justification: Glitch (hosting and editor wound down, farewell post 2025-07-23), Codeanywhere (sunsetting 2026-07-01 per its own blog, no new signups), Bolt.diy workbench (needs an LLM key and a self-hosted Node dev server; it is a WebContainers consumer, so it inherits StackBlitz's column), Theia Cloud (Kubernetes operator for hosting Theia, not a product a user opens; covered by the code-server column conceptually).

## Feature matrix

Legend: Y yes, N no, P partial, ? not verified.

| Dimension | bolo /ide | StackBlitz (WebContainers) | CodeSandbox | Replit | GitHub Codespaces | github.dev / vscode.dev | Gitpod / Ona | code-server (self-host) | Val Town | Sandpack (library) |
|---|---|---|---|---|---|---|---|---|---|---|
| Execution model | Fully client-side (browser V8 worker plus shims) | Client-side (WebContainers, Wasm OS in browser) | Server microVM ("Devbox"), plus client "Sandbox" mode | Server container | Server VM | Client-side editor only, no execution | Server VM (Ona is agent-first) | Your server | Server (Deno-based serverless) | Client-side bundler |
| Server dependency | None after page load (needs static host and the SW) | None for execution (needs StackBlitz origin and registry proxy) | Yes | Yes | Yes | None (except GitHub API) | Yes | Yes (you run it) | Yes | None (bundler is hosted, self-hostable) |
| Node and npm | Shimmed `node:*`, in-browser npm installer, Node v22 reported | Y, real npm/pnpm/yarn via WebContainers | Y (real Node in Devbox) | Y | Y | N | Y | Y | N (Deno/TS only) | N (bundles from npm CDN) |
| Other languages | JS and TS only | JS/TS, no native binaries, Python limited | Any (Devbox) | Any | Any | N | Any | Any | TS | JS frameworks only |
| Vite | Y, in-house `BrowserViteServer`, not the real Vite binary | Y, real Vite | Y | Y | Y | N | Y | Y | N | P (Vite template exists; Sandpack-bundler, not Vite) |
| Next.js | P, Pages Router emulation only. No App Router, no `next build` | Y, real Next (App Router works, some limits) | Y | Y | Y | N | Y | Y | N | N |
| Terminal | P, one-shot command runner per line, plus Node REPL. No PTY, no job control, no tab completion | Y, jsh shell on WebContainers (real prompt, cwd, history) | Y, full bash | Y | Y | N (web), P (desktop) | Y | Y | N | N |
| Preview | Y, iframe via root service worker, HMR over BroadcastChannel | Y, iframe, HMR | Y | Y | Y (port forwarding) | N | Y | Y (proxy) | Y | Y |
| Editor | CodeMirror 6, JS/TS highlighting only, no LSP, no IntelliSense | Monaco/VS Code-like, full TS IntelliSense | Monaco/VS Code-like | Own Monaco-based, AI | Full VS Code | Full VS Code (web) | VS Code | Full VS Code | CodeMirror | CodeMirror 6 |
| Multi-file tabs, search, git | Tabs and tree only. No search, no git, no extensions | Y (search, git via GitHub, extensions limited) | Y | Y | Y | Y (git via GitHub, extensions P) | Y | Y | P | P |
| Collaboration | N | Y (paid) | Y | Y (core feature) | Y (Live Share) | N | P | N | Y | N |
| Persistence | None. Reload returns to the template picker (verified) | Cloud projects with account; anonymous forks are ephemeral | Cloud | Cloud | Cloud | GitHub repo | Cloud | Your disk | Cloud | None (in-memory) |
| Offline | P in principle (client-side, SW), not productized, not verified | N | N | N | N | P (vscode.dev PWA, no run) | N | N | N | N |
| Embeddability | P, iframe of `/ide` only, no embed SDK or postMessage API | Y, `@stackblitz/sdk` embed, WebContainer API for builders | Y, Sandpack and embed | P | N | N | N | P | Y | Y, core purpose |
| License | Apache-2.0 OSS, whole stack open | Proprietary; WebContainer API commercial for production use | Proprietary; Sandpack Apache-2.0 | Proprietary | Proprietary | Closed (VS Code web OSS core) | Gitpod classic OSS history, Ona proprietary | MIT | Proprietary | Apache-2.0 |
| Pricing | Free (static hosting) | Free tier, paid teams and WebContainer API licence | Free tier, paid Devboxes | Free tier limited, paid | Free monthly quota, paid beyond | Free | Free tier changed repeatedly (`?`), contact sales | Free software, your infra cost | Free tier | Free |
| Browser requirements | Chromium, COOP same-origin plus COEP credentialless (set in `astro.config`), service workers. Firefox and Safari untested here | Chromium full; Firefox and Safari 16.4+ beta (per official browser support doc) | Any modern | Any modern | Any modern | Any modern | Any modern | Any modern | Any modern | Any modern |
| Boot, measured here | 18s from template click to preview (dev mode, warm HTTP cache), 15s for Next | Headless run never left "Booting WebContainer" (>150s), headed retry returned 403 Forbidden | Not tested (Cloudflare challenge) | Not tested (login wall) | Not tested (login) | vscode.dev UI in about 12s, no runtime | Not tested (login) | Not tested | Not tested (login) | Embedded demo live in under 10s |
| Notable limits | 2 templates, emulated Next, no native modules, no persistence | No native addons, no real TCP, memory-bound in browser | Free quota and sleep | Free quota | 60h/mo free (per GitHub plan docs, `?`) | Cannot run code | Quota | Ops burden | Not a general IDE | Not a runtime |

## Usability log

Common task: open a Vite + React template, edit a source file, see the preview update, run a terminal command, then try Next.js where offered.

### bolo /ide (http://localhost:4321/ide, tested)

1. Navigated to `/ide`. Picker with two template buttons appeared after about 6s (first load of a cold dev server logged one 504 "Outdated Optimize Dep" from the Astro dev toolbar, harmless noise).
2. Clicked "Vite + React". Status went `installing` and reached `ready` in 18s (polling every 2s, so plus or minus 2s). Terminal showed `npm install`, `npm run dev`, and "Vite dev server: in-browser preview is live at /__preview/".
3. Preview iframe rendered "Hello from React + Vite on bolo!". File tree, CodeMirror editor and terminal all present. Screenshot: `assets/ide/bolo-02-vite-ready.png`.
4. Clicked the `<h1>` line in the editor, selected the line (Home, Shift+End), typed a replacement. Within 4s the preview heading changed to "Edited in bolo IDE" (reload-style update, not verified as true HMR). Screenshot: `assets/ide/bolo-03-edited.png`.
5. Terminal commands: `node -v` printed `v22.12.0`, `ls` listed `importmap.json index.html node_modules package-lock.json package.json src`, `echo hi` printed `hi`, `cat package.json` printed the file, `npm install lodash-es` exited 0 with no visible progress output. Screenshot: `assets/ide/bolo-04-terminal.png`.
6. Reload (F5): app returned to the template picker. The edit and project were lost, no autosave or restore. Screenshot: `assets/ide/bolo-05-after-reload.png`.
7. Picked "Next.js (Pages Router)": ready in 15s, editor opened `pages/index.tsx`, preview showed "Welcome to Next.js on bolo". Screenshot: `assets/ide/bolo-06-next-ready.png`.

Friction: no way to create a file or folder from the UI (verify; I saw no affordance), no project switcher without reload, terminal is not a shell, `.npm-cache` shown in the file tree, no install progress, no error surface beyond the status dot.
Failures: none during the run. A first attempt was disturbed because another agent was reusing the same playwright session name; a unique session name fixed it. This is a test-harness issue, not a bolo bug.

### StackBlitz (https://stackblitz.com/fork/vite-react-ts, tested, failed)

1. The page loaded the full workbench chrome in about 26s (header, empty file tree, Bolt AI prompt, terminal prompt `~/projects/vite-react-ts`) but stayed on "Booting WebContainer" with an empty file tree and no preview for the whole 150s window. Console showed 0 errors. Screenshot: `assets/ide/stackblitz-01.png`.
2. Retried once headed in a fresh profile: the page returned "Forbidden: You don't have permission to access this resource." Screenshot: `assets/ide/stackblitz-02.png`. Likely anti-abuse after the first attempt, or fork rate limiting. I did not retry further.
3. Conclusion: could not complete the task. This is a test-environment limitation, not a verdict on StackBlitz's quality. Observed UX before failure: a "Sign in / Get started" CTA, strong push to bolt.new AI, 4.8K forks shown, otherwise familiar VS Code-like layout with a real terminal prompt.

### CodeSandbox (https://codesandbox.io/p/devbox/vite-react-ts, not tested)

Page title "Just a moment...": Cloudflare challenge for the automated browser. Not bypassed. No screenshot captured.

### vscode.dev / github.dev (tested the landing only)

`github.dev` redirects to `vscode.dev/github/`. vscode.dev loaded to the Welcome page ("No Folder Opened", Open Folder / Open Recent) in roughly 12s. It has no terminal, no Node, no preview for a Vite app. Local folders via the File System Access API require Chromium and user gesture. Screenshot: `assets/ide/vscodedev-01.png`.

### Sandpack (https://sandpack.codesandbox.io/docs/getting-started/usage, tested as a library demo)

Live examples (CodeMirror 6 plus bundler iframe from `2-19-8-sandpack.codesandbox.io`) rendered in under 10s with framework tabs (React, Solid, Svelte, Vue, Vanilla, Angular, Static). It is an embeddable bundler, not an IDE: no terminal, no real npm install, no Next.js. Screenshot: `assets/ide/sandpack-01.png`.

### Not tested, reason

| Product | Reason |
|---|---|
| Replit | `/new` redirects to `/login` |
| GitHub Codespaces | GitHub login required |
| Gitpod / Ona | `app.gitpod.io` needs login; ona.com pricing page lists only "Contact sales" |
| Val Town | Account needed to create |
| code-server, Theia Cloud | Self-hosted, no public instance |
| Glitch | Winding down (farewell post 2025-07-23) |
| Codeanywhere | Sunsetting on 2026-07-01, no signups |
| Bolt.diy | Self-hosted, needs LLM key |

## Where bolo is better

1. Zero server dependency for execution and no account: the whole stack is open and runs from a static host. No sign-in, no fork limits, no Forbidden.
2. Boot to a working preview in about 18s on a cold profile in dev mode, with a transparent install log, and it worked on first try where StackBlitz did not in my environment.
3. Embeddable and forkable by anyone, no WebContainer API commercial license.
4. One composable stack: the same runtime powers /sandbox, /app and /vibe, so the IDE can be a shell around a reusable container API.

## Where bolo is worse

1. Not a real Node: shims plus an emulated Next. Real packages with native deps, long-tail Node APIs, and App Router Next.js will fail or be unavailable. StackBlitz, Codespaces and CodeSandbox run the real thing.
2. No persistence: reload loses the project. Every competitor except Sandpack keeps work.
3. Editor is basic: CodeMirror with JS highlighting only. No TypeScript IntelliSense, no LSP, search, multi-cursor, git, or extensions. vscode.dev and StackBlitz are far ahead.
4. Terminal is a command runner, not a shell: no PTY, history, completion, pipes (unverified), or interactive programs.
5. Two templates only, no create-file UI, no import from GitHub or zip, no export.
6. No collaboration, no sharing URL, no embed API.
7. Chromium-centric by construction (COEP credentialless plus service workers). Firefox and Safari behavior is untested and StackBlitz documents the same limits as beta.
8. Dev-mode cold start noise; production build performance was not measured.

## Prioritized gap list for bolo

P0 (needed to be credible as an IDE)
1. Persist projects to OPFS (VfsBus already has an OPFS layer) and restore on reload, with a "new project" entry point. Acceptance: reload keeps edits and open tabs.
2. Create, rename, delete file or folder in the tree; unsaved indicator; keyboard save.
3. Surface errors: install failure, dev server crash, preview 404, in the UI (status dot only today).

P1 (competitive parity on core flow)
4. Real shell semantics: persistent cwd, history, Ctrl+C, pipes and redirection, ANSI-correct output, tab completion.
5. TypeScript intelligence in the editor: either Monaco with the TS worker or CodeMirror with a TS language service in a worker.
6. Import and export: GitHub repo or zip import, zip export (`/vibe` already has Export zip, reuse it).
7. Templates: add Vite + vanilla, Vite + Vue/Svelte, Next App Router, plus a "paste package.json" start.
8. Install progress and package search UI.

P2 (differentiators)
9. Share link (project snapshot in URL or hosted blob) and an embed API (`postMessage`, config object) to rival `@stackblitz/sdk`.
10. Offline mode: precache runtime, shims and bundler wasm in the SW, so the IDE is a true PWA. This is bolo's distinctive angle vs StackBlitz, which cannot be offline.
11. Multiplayer via CRDT (Yjs) over WebRTC with no server, matching the "no server dependency" pitch.
12. Cross-browser matrix: document and test Firefox and Safari 16.4+, with a clear fallback message when COEP credentialless is unavailable.
13. File search, git (isomorphic-git over VfsBus), command palette.

## Open questions

1. Whether StackBlitz failure was caused by headless Chromium; a human on a normal profile could confirm. Same for CodeSandbox and the login-gated products.
2. Whether bolo's preview update is HMR or reload; measure in a follow-up.
3. Boot time of a production build with a warm service worker; the figure here is dev mode.
