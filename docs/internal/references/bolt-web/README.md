---
title: "internal: bolt-web spike"
---

# Reference: running bolt.new locally as guidance for /vibe

Spike date: 2026-11-15. Repo: https://github.com/stackblitz/bolt.new (open-source bolt, not the hosted product).

## What was verified end to end

The full loop runs on localhost with zero local Node for the generated app: prompt → streamed `boltArtifact` XML → file writes inside the container → `npm install` inside the container → `npm run dev` inside the container → live preview iframe. See `assets/generation.png` and `assets/interactive.png` (a task added through the preview, app is fully interactive).

## Architecture notes

- Remix app on Cloudflare Pages/Workers. Dev: `remix vite:dev` with `cloudflareDevProxyVitePlugin`.
- The Cloudflare dev proxy injects `COOP: same-origin` + `COEP: require-corp` so `crossOriginIsolated === true` — required for `SharedArrayBuffer`, which WebContainers needs.
- `WebContainer.boot({ workdirName })` (`app/lib/webcontainer/index.ts`) loads `https://stackblitz.com/headless` in a hidden iframe and runs the runtime in a `*.w-corp-staticblitz.com` worker (WASM + Contextify). No `clientId` needed on localhost; free for personal/OSS use, commercial use needs a StackBlitz license.
- Preview servers inside the container are exposed at `*.local-corp.webcontainer-api.io` — the preview iframe points there; proxying is handled by the WebContainer network layer.
- LLM: Vercel ai-sdk `streamText` + a large system prompt (`app/lib/.server/llm/prompts.ts`) that teaches the model the `boltArtifact`/`boltAction` XML dialect. `app/lib/runtime/action-runner.ts` parses the stream and executes `file`, `shell`, `start` actions against the container.
- Terminal is xterm bound to an interactive `jsh` shell inside the container.

## Changes needed to run locally (no Anthropic key)

`model.openrouter.ts` in this dir shows the patch to `app/lib/.server/llm/model.ts` that routes through OpenRouter's OpenAI-compatible endpoint. Two gotchas hit in practice:

- `@ai-sdk/openai` must be era-matched to `ai@3.3.4`. `0.0.72` emits a `response-metadata` stream part that `toAIStream()` rejects with `Unhandled chunk type`; `0.0.34` works.
- Retired/limited model ids 404 (e.g. `anthropic/claude-3.5-sonnet`). Free `:free` models on OpenRouter still run when the key is at its spend limit — `nvidia/nemotron-3-ultra-550b-a55b:free` produced a working todo app. Model list: `GET /api/v1/models` with the key.
- `.env` is not auto-loaded by `remix vite:dev`; export `OPENROUTER_API_KEY` in the shell before `pnpm dev`.

## Repro

```
git clone https://github.com/stackblitz/bolt.new && cd bolt.new
pnpm install && pnpm add @ai-sdk/openai@0.0.34
# apply model.openrouter.ts patch to app/lib/.server/llm/model.ts
export OPENROUTER_API_KEY=...
pnpm dev   # http://localhost:5173
```

## Takeaways for /vibe

- bolt.new is the best public reference for the agent loop around an in-browser sandbox: artifact XML protocol, action runner executing file/shell/start actions, workbench with Code/Preview tabs, embedded xterm.
- The sandbox itself (WebContainers) is closed-source StackBlitz IP, hosted, and licensed for production use. bolo's own runtime is the replacement for exactly this piece — our value proposition is owning that layer.
- bolt.diy (stackblitz-labs) is the community fork with multi-provider LLM support built in; worth checking before writing our own provider abstraction.
- Preview-by-URL (`*.local-corp.webcontainer-api.io`) maps to bolo's sw-sandbox virtual-origin approach — theirs is just remote DNS; ours can stay fully local.
