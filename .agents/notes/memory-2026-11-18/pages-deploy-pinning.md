---
tags:
- bolo
- workflow
---
bolojs.dev deploy breakage (2026-11-18): symptom was root HTML 200 but every hashed asset (`/_astro/*.js|css`), `/catalog/`, `/docs/`, `/compat/`, `sw.js`, favicons all 404 (content-length 0, cache-control no-store). Root cause: the deployment pinned to the production alias was broken/incomplete, not a cache issue.

Diagnostic sequence that cracked it:
1. Compare per-deployment subdomain (`<hash>.bolojs.pages.dev`) vs production alias (`bolojs.pages.dev`) vs custom domain (`bolojs.dev`).
2. Cache-bust with a query param: `GET /` returned 200 but `GET /?cb=123` returned 404. That proved the 200 was a stale cached response and the underlying deployment was genuinely empty, not a cache-poisoning problem.
3. `cf-cache-status: DYNAMIC` + `age: 76857` on the prod root, vs `cache-control: public, max-age=0, must-revalidate` on the fresh deployment subdomain.

Fix that worked without dashboard access: `gh workflow run deploy.yml --ref main` (a fresh deploy re-takes the production alias). Takes ~30-60s to propagate.

Note: `wrangler pages deployment promote` does NOT exist in wrangler 4.155 (`wrangler pages deployment` only has list/create/tail/delete). The Cloudflare token is only a GitHub secret (not readable locally), so local wrangler is unauthenticated — a workflow_dispatch redeploy is the lever that works.

Also: the CI deploy uploads ~184 files but only ~39 are new per run ("Uploaded N files (M already uploaded)"), so a redeploy is cheap.