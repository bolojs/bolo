---
title: "internal: dyad-web spike"
---

# Running Dyad as a web app (spike)

Date: 2026-11-15. Dyad commit `0838405` (v1.24.0-beta.1, MIT), cloned to `/tmp/dyad-try/dyad`.

## Result

Dyad runs in a normal browser tab against a plain Node process, with no Electron.
With an OpenRouter key it generated and previewed a working todo app end to end: prompt, questionnaire, blueprint, approve, agent writes files, npm install, Vite preview, git commits (Version 4).
Screenshots: `assets/setup.png`, `assets/todo-result.png`.

This is a spike, not a supported mode of Dyad.
Several features are stubbed (see Gaps).

## Why it works

Dyad's renderer is a Vite React app that only talks to the main process through `window.electron.ipcRenderer` (`invoke`, `send`, `on`).
The main process registers about 348 `ipcMain.handle` channels through `registerIpcHandlers()` in `src/ipc/ipc_host.ts`.
That boundary is narrow enough to replace:

1. `electron-stub.ts` replaces the `electron` module in the Node bundle (`ipcMain` backed by Maps, `app.getPath`, `safeStorage` as plaintext, no-op `BrowserWindow`, `dialog`, `shell`).
2. `host.ts` configures the renderer trust policy for the web origin, runs `initializeDatabase()` and `registerIpcHandlers()`, and serves a WebSocket that forwards `invoke` and `send` frames into the handler maps, and pushes `webContents.send` events back.
3. `shim.js` is injected into `index.html` and defines `window.electron` over that WebSocket.
4. `vite.web.config.mts` serves the unmodified renderer and injects the shim.
5. `build-host.mjs` bundles `host.ts` with esbuild (ESM, `?raw` imports handled by a small plugin, native modules external).

No file under `src/` of Dyad was modified.

## Reproduce

```bash
git clone --depth 1 https://github.com/dyad-sh/dyad /tmp/dyad-try/dyad
cd /tmp/dyad-try/dyad
mkdir web && cp <this dir>/{electron-stub.ts,host.ts,shim.js,vite.web.config.mts,build-host.mjs} web/
pnpm install --no-frozen-lockfile --shamefully-hoist --config.block-exotic-subdeps=false --config.dangerously-allow-all-builds=true
node web/build-host.mjs
set -a; . /path/to/.env; set +a   # must export OPENROUTER_API_KEY
DYAD_WEB_USERDATA=/tmp/dyad-try/userdata node .web/out/host.mjs &
node_modules/.bin/vite --config web/vite.web.config.mts &
# open http://localhost:5174
```

Notes:

- Dyad is an npm project. pnpm needs `--shamefully-hoist` because the code imports undeclared transitive deps (`fs-extra`, `pg`, `@babel/traverse`, `@ai-sdk/provider`), and the exotic-subdep block disabled for an `@electron/node-gyp` git dependency.
- Native builds (`better-sqlite3`, `dugite`, `node-pty`, `esbuild`) must run for plain Node, not Electron ABI.
- Dyad reads `OPENROUTER_API_KEY` from the environment, so the key never touches the UI.
- In the UI: reject the telemetry banner, pick model "Free (OpenRouter)" (the default "Auto" needs Pro), then send a prompt.
- `dyad-apps` is written to `~/dyad-apps`, not under `DYAD_WEB_USERDATA`.
- The first load logs one validation error because JSON turns `undefined` into `null`; the host maps `null` args back to `undefined`.

## Observed behavior

- Agent flow took about 7 minutes on the free OpenRouter model, mostly model latency.
- The preview is the generated app's own Vite dev server in an iframe, which Dyad spawns in Node (`npm ci`, `npm run dev`). It is a real server-side process, not in-browser.
- The page went blank once during a long generation (the WebSocket has no reconnect and the page was idle); a reload restored the full state from SQLite.

## Gaps and risks

- Security: the host has no auth and `safeStorage` is plaintext. It executes agent-written code and shell commands as the local user. Bind to localhost only.
- Stubbed or broken: native dialogs (import app folder), `shell.openExternal`, `WebContentsView` preview embedding and CDP broker (visual editing, console capture), `utilityProcess` workers, deep links and OAuth return flows, auto-update, keychain.
- Managed pnpm auto-install failed (`npm install` spawn error) and the UI shows an "Install pnpm" banner. It did not block the build.
- Single client assumed; broadcasts go to every connected socket.

## Takeaways for bolo `/vibe`

- Dyad's value is the agent loop and UX around the sandbox: questionnaire and blueprint approval, versions with Undo and Retry, a Problems panel, and file and console feedback to the model. bolo `/vibe` has only 5 tools and no error feedback; see `docs/internal/comparisons/vibe.md`.
- The same split could host Dyad's runtime inside bolo: replace the Node host with bolo's in-browser runtime (VFS, `@bolojs/runtime`, `BrowserViteServer`) behind the same `invoke`/`on` contract. The blocker is the surface (git via dugite, `npm ci`, `node-pty`, SQLite via better-sqlite3), each of which needs a browser equivalent.
- A smaller first step is to copy Dyad's tool schema and prompts (`src/prompts`, `src/pro/main/ipc/handlers/local_agent/tools`) as the reference for `/vibe`'s LLM tool surface.
