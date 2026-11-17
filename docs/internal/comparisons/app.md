---
title: "internal: /app comparison"
---

# Competitive comparison: bolo /app vs API clients and in-browser full-stack tools

Date: 2026-11-14. Scope: the `/app` subsite of `apps/site/landing` versus widely used API clients, data studios and in-browser full-stack environments.

## TL;DR

bolo /app is not an API client in the Postman sense today. It is a small demo of "frontend and backend both in one tab": a route editor on the left, a request builder and response viewer on the right, and a handler runtime that executes plain JS route modules through a ServiceWorker virtual origin (`/__virtual__/8787/*`).

What it does that no competitor in the list does: the backend itself lives in the tab. You edit a handler, it hot-reloads, and the request builder hits it with no server, no install, no tunnel, no account.

What it cannot do: send a request to any real URL. The client rewrites every URL under the virtual base, so `https://httpbin.org/get` becomes the path `/__virtual__/8787/https://httpbin.org/get` and returns a 404 from the local backend (tested, see log). There is no CORS story, no proxy, no agent, no collections, no environments, no scripting, no auth helpers, no import or export, and only REST-shaped HTTP.

## Method and assumptions

- Docs comparison: official docs fetched on 2026-11-14 (Hoppscotch interceptors, Postman agents, Postman pricing, Yaak pricing, Bruno README, Insomnia landing). Where a cell says "docs" it is from those pages; where it says "recall" it is from prior knowledge and was not re-verified in this pass. Treat "recall" cells as lower confidence.
- Usability: real browser (playwright-cli, Chromium), no accounts, no credentials. Tested: bolo /app (local dev server), Hoppscotch web. Loaded only (not exercised): httpie web, Swagger Editor. Skipped: Postman web (account needed to start), Apidog (login), Insomnia, Bruno, Yaak, Thunder Client (desktop or VS Code, no web version), Drizzle/Prisma/Supabase Studio and Retool (need a live database or an account), Firecamp (not reachable without signup in this pass), Val Town and StackBlitz (login or heavy session, out of time box).
- `dits` at `../dits` was inspected. It is a self-hosted voice interview app (SQLite, one local process), not an in-browser full-stack tool. Its only relevance is the "contract-first" layout (versioned `/api/v1`, one fetch client, shared valibot schemas) that bolo /app copies in `contract.ts` and `client.ts`. It is not a comparable product and is excluded from the matrix.
- Time box: 60 minutes. Dev server ran on port 4322 because 4321 was taken by another local session.

## Feature matrix

Legend: yes, no, partial, n/a. "Any URL" means a request to an arbitrary third-party origin that does not send CORS headers.

| Tool | Runs in browser | Any URL (CORS) | Hosts backend in browser | Collections | Env vars | Scripting and tests | Protocols | Import / export | Persistence and sync | Offline | License | Price |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bolo /app | yes, only mode | no (URL rewritten to virtual origin) | yes (SW virtual localhost, JS route modules) | no | no | no (valibot contract check on 2 hardcoded paths only) | HTTP request/response only (no WS, SSE, GraphQL UX, gRPC) | no | OPFS snapshot of route files only | yes after load (SW + OPFS) | OSS (repo license) | free |
| Postman web | yes | via agents: Desktop Agent (all protocols), Cloud Agent (HTTP only, no private network), Interceptor extension (docs) | no | yes | yes | yes (JS pre-request and tests) | HTTP, GraphQL, WS, Socket.IO, gRPC, MQTT via Desktop Agent (docs) | OpenAPI, curl, HAR (recall) | cloud, account required | no | closed | Free (10k API calls/month cap, 1 user), Solo $9, Team $19/user (docs) |
| Insomnia | no (desktop) | n/a (desktop, no CORS) | no | yes | yes | yes (recall) | REST, GraphQL, gRPC, WS, SSE (recall) | OpenAPI, curl, HAR (recall) | local vault, cloud sync, Git sync (docs) | yes | open source desktop (docs) | Essentials, Pro, Enterprise (docs, no prices) |
| Bruno | no (desktop) | n/a | no | yes, plain files (Bru) | yes | yes (JS, recall) | REST, GraphQL, gRPC (recall) | OpenAPI, Postman, Insomnia import (recall) | files + Git, no cloud sync planned (docs) | yes | MIT (docs); paid editions exist (docs) | free core, paid tiers |
| Hoppscotch | yes (hoppscotch.io, self-host) | partial: Browser interceptor fails CORS; Agent, Proxy, Extension interceptors fix it (docs, observed) | no | yes (local without login, observed empty state) | yes | yes (pre-request and post-request scripts, tests, observed tabs) | REST, GraphQL, WS, SSE, Socket.IO, MQTT (recall) | curl paste, OpenAPI, Postman (recall) | local, optional account sync | PWA (recall) | MIT (recall) | free, paid enterprise self-host (recall) |
| Yaak | no (desktop) | n/a | no | yes | yes | plugins (recall) | REST, GraphQL, gRPC, WS, SSE (recall) | curl, Postman, Insomnia, OpenAPI (recall) | local-first, Git sync (docs: no data sent to Yaak) | yes | MIT source, paid prebuilt binaries for work use (docs) | free personal; $79/year, $349 lifetime, $149/user/year business (docs) |
| Thunder Client | VS Code extension | n/a | no | yes | yes | yes (recall) | REST, GraphQL (recall) | curl, Postman, OpenAPI (recall) | local, paid team sync (recall) | yes | closed (recall) | free tier, paid (recall) |
| httpie web | yes (httpie.io/app) | recall: browser-limited | no | yes (loaded: Collection, Drafts, Environments UI) | yes | no (recall) | HTTP | curl, Postman (recall) | "Incognito space" without login (observed) | no | partial OSS CLI, app closed (recall) | free tier (recall) |
| Swagger UI / Editor | yes | partial: Try-it-out is CORS-bound (recall) | no | no | no | no | REST (OpenAPI), AsyncAPI editing (observed sample) | OpenAPI is the format | none without account | no | Apache-2.0 (UI, recall) | free; SmartBear upsells (observed) |
| Apidog | yes + desktop | recall: browser agent needed | has cloud mock server (not in browser) | yes | yes | yes | REST, GraphQL, WS, gRPC (recall) | OpenAPI, Postman (recall) | cloud, account | partial | closed | free tier (recall) |
| Firecamp | yes (recall) | recall: needs agent | no | yes | yes | yes | REST, GraphQL, WS, SSE (recall) | limited | cloud | no | partial OSS (recall) | free (recall) |
| Paw / RapidAPI client | no (macOS desktop) | n/a | no | yes | yes | yes | REST, GraphQL (recall) | many (recall) | iCloud / team | yes | closed, folded into RapidAPI (recall) | recall |
| Drizzle Studio / Prisma Studio / Supabase Studio | local-served web UI | n/a (talks to a DB, not arbitrary URLs) | no | no | no | SQL editor | database wire | n/a | the DB | no | OSS (Prisma, Drizzle), Supabase Apache-2.0 (recall) | free |
| Retool | yes (cloud) | server-side proxy, any URL | no (cloud backend) | app builder | yes | JS | REST, GraphQL, DB | n/a | cloud | no | closed | free tier, paid (recall) |
| StackBlitz WebContainers | yes | no raw TCP; fetch only, CORS-bound (recall) | yes (Node in WASM, `localhost` via SW) | n/a | n/a | full Node | full Node ecosystem | git | cloud projects | partial | closed runtime, OSS wrapper | free tier (recall) |
| Val Town | yes (hosted) | server-side runtime, any URL | no (runs on their servers, not in your tab) | n/a | secrets | TS vals | HTTP, cron, email | n/a | cloud | no | closed | free tier (recall) |

Key reading of the matrix:

- bolo is alone in the "hosts the backend inside the tab as a first-class feature with request builder attached" cell, apart from StackBlitz WebContainers which is a full Node environment rather than an API client.
- Every browser-hosted competitor that can hit any URL does it with a non-browser helper: a desktop agent, a cloud agent, a browser extension or a proxy. None solves CORS in pure browser JS because it cannot be solved there.
- Every desktop competitor sidesteps the problem entirely.

## Usability log

Environment: macOS, Chromium via playwright-cli, no login anywhere. Screenshots in `assets/app/`.

### Task 1: GET https://httpbin.org/get

- bolo /app: fail. The URL field defaults to the virtual path. Typing `https://httpbin.org/get` and sending returns `404 {"error":"no route for GET /https://httpbin.org/get"}` from the local backend. Cause: `toVirtualPath` in `apps/site/landing/src/subsites/app/client.ts:17` prefixes the virtual base to anything that does not already start with `/__virtual__/`. Screenshot: `bolo-httpbin.png`.
- Hoppscotch: pass. Open page, replace URL, press Send. `200 OK, 336 ms, 864 B`, JSON viewer with line numbers. Roughly 20 s wall clock including my automation steps, page was already usable at load with a prefilled request. No login. Screenshot: `hoppscotch-get.png`.

### Task 2: POST with a JSON body

- bolo /app: partial. The starter backend has only two GET routes, so POST `/api/v1/items` returns `404 no route for POST /api/v1/items` (correct, as designed). After rewriting `routes/items.js` as a POST handler in the in-page editor, the route list updated within about 2 s ("routes applied"), and the same POST returned `201 {"created":{"name":"x"},"ok":true}`. This is the product's real strength: edit handler, send, see the result, no restart. There is no UI to add a new route file; you can only edit an existing file, so adding a POST meant overwriting a GET route. Screenshot: `bolo-post-live-edit.png`.
- Hoppscotch: not completed by me. I typed a curl command into the URL field, but typing is not a paste, so the curl importer did not trigger and it was treated as a URL. This is an artifact of my automation, not a product failure. The Body, Headers, Authorization and Pre/Post-request Script tabs are present and the curl-paste feature is documented. Screenshot: `hoppscotch-post-curl.png`.

### Task 3: save to a collection and use an env variable

- bolo /app: not possible. No collections, no saved requests, no environments, no `{{var}}` interpolation. The only saved state is the route source (OPFS snapshot), which I verified survives a reload (both edited routes were still listed after reload).
- Hoppscotch: UI present without login (Collections panel with Import and Add new, "Select environment" dropdown). I did not exercise save or variable substitution in the time box. Marked as "present, not exercised".

### Task 4: CORS-restricted URL

- bolo /app: same failure as Task 1, no mechanism at all.
- Hoppscotch: GET `https://example.com/` fails in the default Browser interceptor with "Network Error: Unknown cause" and an inline Interceptor picker offering Browser, Proxy, Agent, Browser extension. The failure message does not say "CORS" by name, but the remedy is one click away. Screenshot: `hoppscotch-cors.png`. This is the standard best-in-class browser-client behavior and the bar for bolo.

### Task 5: call a localhost-style backend

- bolo /app: pass, and this is the differentiator. The page's own backend answers at `/__virtual__/8787/api/v1/items` with no process, port or tunnel. Default GET returned `200` with the items payload and the contract badge UI (valibot check, only for `/api/v1/hello` and `/api/v1/items`).
- Hoppscotch and all other web clients: a browser client cannot reach `http://localhost:*` without a local agent or extension, and mixed-content and Private Network Access rules add more friction (recall). Not exercised.

### Time to first request

- bolo /app: 13 s for a warm `goto` of `/app/` to `data-boot-state=ready` on a dev server; 70 s on the very first cold load (Vite dependency optimization). Dev numbers, not a production measurement.
- Hoppscotch: usable immediately on load; first 200 within seconds.

### Friction and bugs found in bolo /app

1. Trailing slash. Loading `/app` (no trailing slash, which is what the Astro dev server serves and what the nav links to) leaves the page outside the ServiceWorker scope `/app/`. `navigator.serviceWorker.controller` was `false`, the worker was registered and activated, and every request, including the default Send, returned a 404 from the dev server (`/__virtual__/8787/api/v1/items`). Loading `/app/` fixed it immediately. A static deploy may redirect to `/app/` (not verified); dev mode does not. Worth a bug ticket or a scope fix.
2. Dev console showed `504 (Outdated Optimize Dep)` for the Astro dev toolbar entrypoint on first load. Cosmetic.
3. No way to create a new route file in the UI.
4. The contract badge only appears for two hardcoded paths; for edited routes it silently shows nothing.
5. Header and body inputs are raw textareas (`Header: value` per line), no key/value grid, no JSON editor, no body type switch.
6. Only GET, POST, PUT, PATCH, DELETE are offered; no HEAD, OPTIONS.

Other tools loaded but not exercised: httpie web opened with an "Incognito space" and a promo modal for an AI assistant, no login needed (`httpie-web.png`). Swagger Editor loaded an AsyncAPI sample with a SmartBear promo overlay and a "Sign in" button (`swagger-editor.png`).

## Where bolo is better

- Backend in the tab: edit a JS route, hit Send, see the result in about two seconds. No competitor in the API-client category does this.
- Zero install, zero account, zero server, zero cloud. Works offline after first load.
- Same-origin virtual localhost sidesteps mixed-content and Private Network Access problems that make browser clients unable to talk to localhost.
- Stack is portable: a route module is a plain `fetch`-style handler (Request in, Response out), so it ports to Workers, Deno or Bun.
- Natural pairing with the other subsites (IDE, sandbox, vibe): the generated app and its API client share one container.

## Where bolo is worse

- Cannot call any real URL. This is the core job of an API client. Without it /app is a demo, not a tool.
- No collections, environments, auth helpers, scripting, tests, history, import or export.
- Only one request tab, no tabs or workspace.
- Backend runtime is deliberately narrow: JS ESM modules with no imports, injected `{ params, schemas }`, exact-segment `:param` matching, no query parsing helper, no npm packages, no storage API (no DB, KV or fetch-out helper), no state across reloads except the route sources.
- Persistence is one OPFS JSON blob of route files; no export, no Git, no share link.
- Protocols: no WebSocket, SSE streaming view, GraphQL explorer or gRPC.
- Ecosystem and trust: Postman, Insomnia, Bruno and Hoppscotch have years of users, docs and integrations.

## Prioritized gap list

P0 (blocks "API client that works with any URL"):

1. Fix `toVirtualPath` so absolute `http(s)://` URLs are passed through to real `fetch` instead of being rewritten. Smallest change, turns a 404 into either a response or an honest failure.
2. Add an interceptor model like Hoppscotch's: Browser (default), a documented relay option, and an explicit "this failed because of CORS" message with remedies. The repo already ships `apps/tcp-relay` (self-hosted WS/WebTransport to TCP relay); a small user-operated HTTP forward proxy of the same kind, plus an optional browser extension, would cover the field. Be honest in the UI that pure-browser fetch cannot bypass CORS.
3. Fix the `/app` vs `/app/` ServiceWorker scope bug (or serve the SW with a wider scope and `Service-Worker-Allowed`), so the default Send works from the nav link in dev.

P1 (parity with entry-level clients):

4. Saved requests and collections (local, OPFS or IndexedDB), history, multiple tabs.
5. Environments and `{{variable}}` interpolation in URL, headers, body.
6. Structured request editors: key/value params and headers, body types (JSON, form, raw), auth helpers (Bearer, Basic, API key).
7. Import and export: paste curl, import OpenAPI and HAR, export curl and collection JSON. Hoppscotch's curl paste is the benchmark.
8. "New route" button and route templates; a way to add handlers without overwriting.

P2 (differentiation, leaning on the in-tab backend):

9. Pre-request and test scripts, sharing the existing handler runtime.
10. Auto-generate the request collection from the backend's routes and from an OpenAPI spec; validate responses against the spec instead of two hardcoded valibot schemas.
11. Backend capabilities: query and JSON helpers, storage (KV or SQLite-in-OPFS), outbound `fetch` from handlers, `Response` streaming for SSE.
12. WebSocket and SSE tabs; GraphQL schema introspection.

P3:

13. Share links and export of backend plus collection as a single project; Git sync through the vfs.
14. Docs page and compat entry for /app so claims are checkable.

## Sources

- Hoppscotch interceptors: https://docs.hoppscotch.io/documentation/features/interceptor
- Postman agents: https://learning.postman.com/docs/getting-started/basics/about-postman-agent/
- Postman pricing: https://www.postman.com/pricing/
- Yaak pricing: https://yaak.app/pricing
- Bruno repository: https://github.com/usebruno/bruno
- Insomnia: https://developer.konghq.com/insomnia/
- bolo source: `apps/site/landing/src/subsites/app/` (`AppSubsite.tsx`, `backend.ts`, `client.ts`, `contract.ts`, `persistence.ts`, `starter.ts`)
