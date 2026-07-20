# @bolojs/example-app-builder

A Lovable/v0/bolt.new-style AI app builder, running entirely in the browser on
top of bolo's in-browser Node.js runtime (`bolojs`). This example
exists to prove bolo's existing core infrastructure already supports the
"AI app builder" use case without any app-builder-specific changes to core.

Chat with an LLM (via OpenRouter, bring-your-own-key), and it edits files,
installs dependencies, and runs commands inside a real Node.js sandbox
running in your tab — with a live preview, in-browser file editor, and
terminal, updated as the model works.

## Running locally

```bash
pnpm --filter @bolojs/example-app-builder dev
```

Open the printed URL. A config dialog opens automatically on first run — set
an OpenRouter API key and pick a model, then start chatting. Reopen it later
from the ⚙ button in the sidebar header.

## How it works

- `src/container/useContainer.ts` boots a `bolojs` container, mounts
  a starter Vite+React project (`src/container/scaffold.ts`), and runs
  `npm install`.
- `src/container/tools.ts` exposes the container's filesystem and process
  spawning as AI SDK tools (`writeFile`, `readFile`, `deleteFile`,
  `listFiles`, `runCommand`). `runCommand` waits up to 5s for the process to
  exit and otherwise reports it as still-running rather than blocking — this
  is what lets the model start a long-lived dev server without hanging the
  chat loop.
- `src/ai/useBuilderChat.ts` runs each turn as two AI SDK v7 `streamText`
  calls against OpenRouter: a tool-free "plan" step (short bullet plan,
  shown in the chat in italics) followed by a "build" step with the
  container tools and `stopWhen: stepCountIs(8)`, seeded with the plan as
  conversation context. `src/ui/ConfigDialog.tsx` lets you pick separate
  plan/build models (fetched from OpenRouter's `/api/v1/models`) or use one
  model for both via a checkbox.
- `src/container/persist.ts` snapshots the container's virtual filesystem
  (via `@bolojs/fs`'s `VfsBus.snapshot()`/`restore()`) into IndexedDB on
  every install/command, and restores it on reload — so a refresh doesn't
  lose the project.
- `src/container/exportZip.ts` zips the project (via `fflate`, excluding
  `node_modules`/`.git`/`.npm-cache`) and triggers a browser download —
  the "Export .zip" button above the preview/code tabs.

## Security

**BYOK key handling.** Your OpenRouter API key is stored in this tab's
`localStorage` and sent directly from the browser to OpenRouter's API on
every chat request — there is no server in this example to hold or proxy it.
Anything with script access to this page (a malicious/compromised browser
extension, an XSS bug in this app, or anyone with your devtools open) can
read it. Use a key you're comfortable rotating, and consider setting a spend
limit on it in the OpenRouter dashboard. Click "forget API key" to clear it
from localStorage.

**`dangerouslyAllowSameOrigin`.** This example does **not** set
`dangerouslyAllowSameOrigin` on `boot()` — the AI-authored code the model
writes and runs is untrusted by construction (it's LLM output), so it runs
inside bolo's default iframe sandbox, not with same-origin access to this
page. Do not flip that flag on for a chat-driven code generator: it would
let AI-authored code read/write this page's cookies, localStorage (including
the API key above), and DOM.

## Known debt

`public/sw.js` is a **copied**, not built, service worker script (mirrors
`apps/site/landing/public/sw.js`). `@bolojs/sandbox`'s `SWSandbox`
registers the service worker as a classic (non-`type: "module"`) script, but
`packages/sw-sandbox/src/sw.ts` is written as an ES module (`export function
initSW(...)`) — shipping its build output directly would be invalid in a
classic worker context. Properly fixing this (e.g. a bundled classic-script
entry point built from `packages/sw-sandbox`) is generic infrastructure any
consumer of the sandbox would benefit from, so it's left as follow-up
project work rather than being bolted onto this example.
