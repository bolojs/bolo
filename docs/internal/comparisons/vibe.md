---
title: "internal: /vibe comparison"
---

# bolo /vibe vs AI vibe-coding alternatives

Date of research: 2026-11-14.
Scope: the AI vibe-coding environment where an LLM drives a sandbox. Sibling subsites (/ide, /sandbox, /app) are covered by other comparison docs.

## Method and honesty notes

Specs come from official docs, pricing pages and GitHub READMEs fetched on 2026-11-14.
Hands-on testing followed the rules of this task: no accounts, no credentials, no API keys.
Result: only bolo /vibe was tested hands-on (with its mock provider).
Every other product was either behind login (bolt.new, v0, Google AI Studio) or a Cloudflare bot wall (Lovable, Replit), so those rows are docs-only plus pre-login screenshots.
bolt.diy was not cloned and run within the time box, so its row is README-only.
Where a cell says "(unverified)" it comes from general knowledge, not from a page fetched in this session.
No product other than bolo was exercised on the identical "todo app with add/delete" task, so there is no real time-to-first-preview comparison; see the usability log.

## Products compared

Included: bolt.new, bolt.diy, v0, Lovable, Replit Agent, Anything (create.xyz), Firebase Studio, Google AI Studio Build, Claude Artifacts, OpenHands, Open Lovable, Dyad.
Dropped or reduced: GPT Engineer (gptengineer.app now 301-redirects to lovable.dev, it is Lovable's former name, so it is not a separate competitor).
Same.dev: the github.com/nutlope/same.dev URL returned 404 and no official page was reachable, so it is listed as "not verified" and excluded from the matrix.
Windsurf and Cursor cloud agents: not matrixed. They are IDE or repo-centric agents running on cloud VMs with full shell, which is the capability ceiling bolo's tool surface is measured against below (unverified, from general knowledge).

## Matrix

| Product | Where code runs | LLM choice / BYOK | Tool surface for the LLM | Frameworks | Deploy / export | Persistence / versioning | Collab | License | Pricing (2026-11-14) | Self-host |
|---|---|---|---|---|---|---|---|---|---|---|
| **bolo /vibe** | In the browser (bolo runtime: VfsBus + in-house bundler/Vite-in-browser + SW preview). No server. | OpenRouter only (any model by id, default `tencent/hy3:free`) plus a mock. BYOK in localStorage, direct browser to provider. | 5 tools: writeFile, readFile, deleteFile, listFiles, runCommand (allowlist node/npm/npx/git, 5s wait). Plan then build, max 8 steps. No preview/console/error feedback tool. | Vite + React starter only (Next.js exists in repo as next-server but is not wired to /vibe) | Export zip. No deploy, no GitHub. | IndexedDB snapshot after each turn, single project "default". No history, no undo, no diff. | None | OSS (bolojs repo) | Free; user pays their own LLM | Static site, trivially self-hostable |
| **bolt.new** | WebContainers in the browser (StackBlitz), cloud for hosting | Platform-managed models, no BYOK on the pricing page | Not documented publicly; known to write files, run shell in WebContainer, read terminal and preview errors (unverified) | Vite/React/Next/Astro, node-only (unverified) | Hosting on bolt, custom domain on Pro, GitHub import (from landing page) | Cloud projects | Teams plan | Closed | Free 1M tokens/mo (300K/day), Pro $25, Teams $30/user | No |
| **bolt.diy** | WebContainers in the browser (or Electron, Docker) | 22+ providers incl. OpenAI, Anthropic, Gemini, Groq, xAI, DeepSeek, Ollama, LM Studio, OpenRouter. Per-prompt model pick. Keys in UI (cookies) or env. | Files, shell, MCP tools, codebase search; GitHub/GitLab/Netlify connectors | Anything WebContainers runs | ZIP, Git push, Netlify, Vercel, GitHub Pages | Snapshots, git clone/push, visual diff | No | MIT (WebContainers API has its own commercial terms) | Free, pay own LLM | Yes: Docker, pnpm dev, Electron |
| **v0** | Vercel cloud (sandboxed) | v0 Mini/Pro/Max models (Vercel's own), ChatGPT plan login option on landing | Not documented here | Next.js/React/shadcn focus | One-click Vercel, GitHub sync | Cloud chats, GitHub | Plus/Business shared credits and chat sharing | Closed | Free 7 msg/day, Plus $30/user, Business $100/user; model rates $0.20-$50 per 1M tokens | No |
| **Lovable** | Cloud (Lovable Cloud, Supabase backend) | Platform-managed | Not documented here | React + Vite + Tailwind + Supabase (unverified) | Lovable Cloud hosting, GitHub sync (unverified), "you own the code" | Cloud | Unlimited workspace members, shared credit pool | Closed | Free 5 credits/day (30/mo), credit-based paid plans | No |
| **Replit Agent** | Replit cloud VM (full Linux) | Platform-managed, "more powerful models" bought with credits | Full shell/IDE on VM, can run any language | Anything | Replit Deployments | Cloud, DB rollback up to 28 days on Pro | Up to 15 collaborators on Pro | Closed | Core $20, Pro $100, Free Mode limited (bot-walled, page content incomplete) | No |
| **Anything (create.xyz)** | Cloud | Platform (GPT-5 named on landing) | Not documented | Web + mobile apps, 40+ integrations | Not stated | Cloud | Not stated | Closed | Not stated on landing page | No |
| **Firebase Studio** | Cloud VM (Code OSS on Cloud Workstations) | Gemini | Full IDE + App Prototyping agent | Next.js, React, Angular, Vue, Flutter, Android, Go, Java, .NET, Flask | Firebase App Hosting | Cloud workspace | Shareable | Closed | Free; NOTE: new workspace creation and signup no longer supported, migration guide linked | No |
| **Google AI Studio Build** | Frontend client-side React, server side Node on Cloud Run | Gemini (GEMINI_API_KEY kept as server secret) | Agent installs npm packages, edits code | React + Node; Kotlin for Android | Cloud Run publish, ZIP, two-way GitHub sync | Cloud, GitHub | Shared apps use owner's quota | Closed | Free tier of Gemini, Cloud Run usage billed | No |
| **Claude Artifacts** | Anthropic-hosted sandbox; AI-powered artifacts run on Anthropic infra | Claude only; end users use their own Claude plan, no key needed | Model writes the artifact; not a general shell | Not documented on the page | Share; new artifacts changed after 2026-09-16, legacy can be copied | Per-artifact storage 100 MB / 25k docs | Team/Enterprise sharing | Closed | Free plan can create artifacts, storage needs Pro | No |
| **OpenHands** | Docker sandbox per conversation, or host directly | Any LLM (profiles); can drive Claude Code, Codex, Gemini CLI, ACP agents | Full agent (shell, editor, browser per project description, page itself does not enumerate) | Anything | None built in, it is an agent not a host | Server-side conversations | Shared team server option | MIT | Self-host free; cloud pricing not on page | Yes, central theme |
| **Open Lovable** | Remote sandbox (Vercel Sandbox default or E2B) | Gemini, Anthropic, OpenAI, Groq; env keys | Writes into sandbox; optional Morph Fast Apply | React | Not described | Not described | No | MIT | Free + needs Firecrawl key, sandbox creds, LLM key | Yes, local dev server |
| **Dyad** | Local desktop app (Mac/Windows), project on disk | BYOK incl. Anthropic, OpenAI, Gemini, DeepSeek, Qwen, Ollama | Local file edits and local dev server (details not on page) | Next.js, React, Vite apps | Not described on page | Local git repo (unverified) | No | Apache 2.0, `src/pro` under FSL 1.1 | Free app, pay own LLM | Local by design |

## Usability log

### bolo /vibe (hands-on, mock provider, local dev server)

Setup: `pnpm install`, `pnpm turbo run build --filter='@bolojs/site-landing^...'` (all 12 tasks cached), `astro dev` on a free port. Chrome via playwright-cli.
Task: "build a todo app with add/delete" with `bolo-vibe:provider=mock`.

Observations:

1. Boot: the page rendered the chat, empty preview and a terminal showing `npm install` exit 0 within a few seconds on a warm cache (second visit). On the very first dev-server hit the page stayed blank for about 20s while Vite re-optimized dependencies (console: 504 "Outdated Optimize Dep"). Dev-mode only, but a cold first visit is rough.
2. Generate: plan streamed, then writeFile `src/App.jsx`, then `runCommand npm run dev` appeared as tool receipts. Terminal printed "Vite dev server: in-browser preview is live at /__preview/".
3. Preview: after the run the preview iframe showed the mock page "Built by the bolo mock provider". Time from Send to rendered preview was roughly 10s, dominated by the fixed 5s runCommand wait for the never-exiting dev server plus mock delays. The mock ignores the prompt, so this says nothing about real generation latency, and no todo app was produced.
4. Bug found: loading `/vibe` (no trailing slash, which is the exact href used by the site nav and the catalog) leaves the page outside the service worker scope `/vibe/`. The page is never SW-controlled, `/__preview/` returns 404 and the preview stays "No server yet" even though the tool receipts and terminal claim success. Loading `/vibe/` works. Observed on the astro dev server; whether production hosting redirects `/vibe` to `/vibe/` was not verified.
5. Fix-error loop: not exercisable with the mock. By code reading there is no loop: the only feedback is the stdout of runCommand (5s window). Vite compile errors that appear later in the preview, runtime exceptions in the iframe and browser console output never reach the model. The model must guess that something broke from the user's next message.
6. AI SDK warns that the mock uses v2 spec compatibility mode (cosmetic).

Screenshots: `assets/vibe/bolo-vibe-initial.png`, `assets/vibe/bolo-vibe-mock-result.png`.

Side effect to disclose: early in testing I reused a playwright session name that already belonged to another agent's browser (it was pointed at a different port and subsite). I issued a `localstorage-set` and a fill/click there before noticing. Then, while cleaning up, I ran `pkill -f "astro dev --port 4321"`, which may have stopped another process's dev server on 4321. Both should be checked by whoever owned those sessions.

### Others (not hands-on)

| Product | What was reachable | Evidence |
|---|---|---|
| bolt.new | Landing page and prompt box without login. Typing a prompt and pressing Build now did not start a build, it stayed on the landing page (login gate presumably). | `assets/vibe/bolt.new.png` |
| v0 | Landing with prompt box, model picker (v0 Max), Log In and Sign Up. Not submitted. | `assets/vibe/v0.png` |
| Lovable | Cloudflare "verify you are human" wall. Not bypassed. | `assets/vibe/lovable.png` |
| Anything | Marketing landing only. | `assets/vibe/anything.png` |
| Google AI Studio | Redirects to Google sign-in. | none kept |
| Replit | Cloudflare "Attention Required". | none kept |
| bolt.diy | Docs site reachable; app not run locally (time box). | README only |

## Where bolo is worse (honest)

1. Zero proven real-model path. Only the mock was exercised, and the mock ignores the prompt. The OpenRouter path is code-reviewed, not tested here. Default model `tencent/hy3:free` is a free OpenRouter model with unknown tool-calling quality.
2. No error feedback loop. This is the central feature of bolt, Lovable, v0 and Replit and it is missing. See the tool gap list below.
3. Provider choice is one gateway (OpenRouter). bolt.diy, Dyad and OpenHands talk to 20+ providers directly including local Ollama and LM Studio. No direct Anthropic/OpenAI/Gemini keys, no local models.
4. No deploy, no GitHub, no share link. Export zip only. Every hosted competitor has one-click publish.
5. No history: one project slot ("default"), no undo, no per-turn checkpoints, no diff view. bolt.diy has snapshots, git and a diff viewer.
6. No editor or file tree in the vibe layout, so the user cannot hand-edit what the model wrote (the /ide subsite has these, they are not reused).
7. Framework breadth: Vite+React only. Next.js is available in the repo but not offered. No templates picker, no Vue/Svelte/Astro.
8. Command surface: allowlist of node/npm/npx/git. A regex denylist on args is trivially bypassable and gives false assurance, but the real boundary is the browser sandbox. No python, no shell builtins like `ls`, `cat`, `mkdir`, so the model cannot inspect state except through listFiles/readFile.
9. Operational polish: `/vibe` vs `/vibe/` SW scope bug, 5s blocking wait per dev-server start, cold-start blank page in dev, no multi-step progress UI beyond tool receipts.
10. No collaboration, no accounts, no cloud sync, so work lives only in one browser profile's IndexedDB.

## Where bolo is better

1. Truly client-side with no server cost: LLM calls go browser to provider, no bolo infra, no account. Only bolt.diy (WebContainers, proprietary-licensed runtime) is comparable, and it needs StackBlitz's closed WebContainers. bolo's runtime is OSS.
2. Free and uncapped by platform credits (Lovable 30/mo, v0 7 msg/day, bolt 300K tokens/day).
3. Plan-then-build with visible tool receipts and an auditable allowlist; easy to extend since tools are plain AI SDK `tool()` definitions.
4. Self-hosting is a static deploy.

## Prioritized gap list

P0 (blocks calling it a vibe coder)

1. Observation tools for the LLM, see API below. Without them there is no fix loop.
2. Real-provider smoke test (nightly or manual) against OpenRouter with a tool-calling model, plus a recommended-model list and a tool-call capability check in the model picker.
3. Fix `/vibe` without trailing slash (redirect or widen SW scope), and make the preview failure visible instead of "No server yet" while tools report success.

P1

4. Direct providers via AI SDK (Anthropic, OpenAI, Google, Ollama/LM Studio for local) behind the same BYOK UX.
5. Checkpoints: snapshot per turn with undo/restore and a diff of changed files; multiple projects.
6. Reuse /ide FileTree and Editor in the vibe layout.
7. Deploy/share: export to GitHub (isomorphic-git is already a candidate with the `git` tool) and a static publish target.
8. Wait semantics for runCommand: replace the 5s timer with "wait until output matches ready regex or exits", and return structured status.

P2

9. Next.js template via next-server, template picker (Vite React, Vue, Svelte, Next).
10. Streaming file writes so the preview updates while the model is still emitting.
11. Context management: summarize or drop old tool results, since `history` grows unbounded and each turn re-sends everything.
12. Image/screenshot input, Figma import, MCP support (bolt.diy has MCP).

## Proposed LLM tool API for the observation gap

Existing tools stay. Add:

```ts
// Console and runtime errors from the preview iframe, captured by a small
// injected script (window.onerror, unhandledrejection, console.* proxy).
getPreviewLogs({ since?: number, level?: "error" | "warn" | "all", limit?: number })
  -> { entries: { t: number; level: string; message: string; stack?: string }[] }

// Vite/bundler diagnostics from the dev server (compile errors, HMR overlay
// payload, unresolved imports). The same data the Vite overlay shows.
getBuildErrors()
  -> { ok: boolean; errors: { file: string; line?: number; col?: number; message: string; frame?: string }[] }

// Rendered state of the preview, for verifying the UI did what was asked.
inspectPreview({ selector?: string, maxChars?: number })
  -> { url: string; title: string; text: string; html?: string }   // DOM text or outerHTML slice
screenshotPreview({ selector?: string })
  -> { image: "data:image/png;base64,..." }                         // for vision-capable models

// Interaction, so the model can test add/delete in the todo app itself.
interactPreview({ actions: ({ type: "click" | "fill" | "press"; selector: string; value?: string })[] })
  -> { results: { ok: boolean; error?: string }[]; logs: LogEntry[] }

// Process control for the dev server and long commands.
runCommand({ command, args, waitFor?: { regex?: string; timeoutMs?: number }, background?: boolean })
  -> { pid: number; exitCode: number | null; output: string; ready: boolean }
getProcessOutput({ pid: number, since?: number })
stopProcess({ pid: number })

// Cheaper, targeted edits and discovery (reduces whole-file rewrites).
patchFile({ path, edits: { find: string; replace: string }[] })
searchFiles({ query: string, glob?: string })
  -> { matches: { path: string; line: number; text: string }[] }
```

Loop contract for the build step: after any writeFile batch or dependency change, the controller (not the model) should auto-run getBuildErrors plus getPreviewLogs for a settle window (for example 1.5s) and append the result to the next step as a synthetic tool result, so a broken build is seen without the model having to ask. Raise `stepCountIs(8)` or make it budget-based, since fix loops need headroom.

Safety notes for the API: all paths remain project-relative (already enforced), interactPreview selectors only act inside the preview iframe origin, the command allowlist stays, and keep network egress from the sandbox as the real boundary rather than regex denylists.

## Sources

Fetched 2026-11-14: github.com/stackblitz-labs/bolt.diy, bolt.new/pricing, github.com/dyad-sh/dyad, github.com/All-Hands-AI/OpenHands, github.com/firecrawl/open-lovable, lovable.dev/pricing, v0.app/pricing, replit.com/pricing, firebase.google.com/docs/studio, aistudio.google.com/docs/aistudio-build-mode, support.claude.com artifacts article, create.xyz, gptengineer.app (redirect), plus repo source `apps/site/landing/src/subsites/vibe/`.
