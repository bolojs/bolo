---
tags:
- bolo
- ui
---
The bolo `/probe/` endpoint (apps/site/landing/src/pages/probe.astro + src/demo/ProbeApp.tsx), added 2026-11-18:

- URL: `GET /probe/?run=<base64url code>` (raw source also accepted). Info mode with no `run`.
- Execution: NOT the REPL. The REPL (`container.evalRepl`) is synchronous indirect eval — no top-level await, no promise resolution, `import(...)` returns unawaited. Instead the probe wraps user code in `(async () => { const __v = await eval(<code>); if (__v !== undefined) console.log(...); })().catch(e => { console.error(String(e.message)); process.exit(1); })` and runs it via `container.spawn("node", ["-e", wrapped])`.
- `node -e <script> -- <arg>` does NOT propagate argv through the shell quoter (SyntaxError: Unexpected end of input). Code must travel inline via JSON.stringify into the -e script.
- Process output: `container.spawn` merges stdout AND stderr into one stream (`proc.output`). Separate fields by exit code, not by stream.
- `container.startRepl()` must be called before `evalRepl` — the REPL worker is lazy.
- `BrowserContainer` has no `shell` or `version` property; public surface is spawn/mount/evalRepl/fs/events.
- Page contract: single `<pre id="probe-output">` with JSON text; `document.title` carries `ok |` / `error |` prefix.
- Docs live in `docs/api.md` (real file; `apps/site/docs/src/content/docs` is a symlink to `docs/` — git add fails on the symlink path with "beyond a symbolic link").

Landing site checks: `pnpm turbo run typecheck lint format --filter=@bolojs/site-landing`. It uses `exactOptionalPropertyTypes: true` — optional props need explicit `| undefined` when assigning undefined.