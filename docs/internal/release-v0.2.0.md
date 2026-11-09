---
title: Release runbook v0.2.0
description: Ordered steps and open checklist to ship v0.2.0.
---

Human runbook. Nothing here has been run for real. The rehearsal in step 4 never publishes.

Note: this file lives in `docs/`, which is symlinked into the public Starlight site. Move it to `docs/internal/` if it should not be published.

## Branch state when this was written

- `v020/diff-fixes`: same tip as the process-model work (`cea5c83`), no extra commits.
- `v020/node-tests`: one commit on top of `cea5c83` (`c43c0a9`, compat-harness node-tests modules).
- `v020/publish-rc` (this branch): `cea5c83` plus four release commits (rc pre mode, process-model changeset, LICENSE files, rehearsal script, dry-run workflow job).
- The plan referenced in the task (`.agents/plans/2026-11-08-v0-2-0-process-model.md`) is not present in this worktree. The exit-criteria checklist below is derived from the task brief and the rehearsal findings, not from that plan. Reconcile it against the plan.

## Ordered steps

1. Merge order into the integration target (`main`). The process model commits (`db97c9a` to `cea5c83`) are shared by all three branches, so order matters only for the extra commits:
   1. `v020/diff-fixes` (carries the shared process-model history).
   2. `v020/node-tests` (fast-forward on top, one commit).
   3. `v020/publish-rc` last, so the release state (`.changeset/pre.json`, version-less) lands after the code it describes. Expect a trivial conflict only if anything else touches `.changeset/` or `.github/workflows/release.yml`.
2. Fix the release blockers listed under "Open exit criteria" before the rc. At minimum the oxc wasm binding and the shipped test files.
3. Confirm version state. Do not run `pnpm version-packages` locally for real: the release workflow does it. For a local preview only (needs a GitHub token because of `@changesets/changelog-github`): `GITHUB_TOKEN=$(gh auth token) pnpm version-packages`, inspect, then `git reset --hard`. Expected result: all 11 publishable packages at `0.2.0-rc.0`. Verified on this branch with the default changelog generator: `bolojs`, `@bolojs/fs`, `@bolojs/lockfile`, `@bolojs/log`, `@bolojs/node-runtime-shims`, `@bolojs/node-web-shims`, `@bolojs/pm`, `@bolojs/registry`, `@bolojs/sandbox`, `@bolojs/vite-preset`, `@bolojs/vite-server`. Private workspaces (site, harness, tests, examples) also get bumped and get CHANGELOG files; harmless.
4. Rehearsal. Locally: `./scripts/release-rehearsal.sh` (wraps the heavy build in `flock /tmp/tsc.lock`; `KEEP=1` keeps the temp dir). In CI: Actions, Release, Run workflow, `dry-run` job (no `NPM_TOKEN`, cannot publish). Must end with `REHEARSAL OK`.
5. RC publish. Merge to `main`. The `release` job (push to `main`) runs `changesets/action`, which opens a "chore(release): version packages" PR that versions to `0.2.0-rc.0`. Review it, merge it. The next run of the action then runs `pnpm release` (`changeset publish`) and publishes with the `rc` dist-tag because pre mode is active. Check that the tag is `rc`, not `latest`.
6. Verify the rc. In a clean directory outside the repo: `pnpm add bolojs@rc`, `pnpm view bolojs dist-tags`, `pnpm view bolojs@0.2.0-rc.0 dependencies` (must list concrete versions, no `workspace:`), and `npm audit signatures` or the provenance badge on npmjs.com for each package. Run the app-builder example and the differential runner against the installed packages.
7. Iterate. For fixes, add changesets and let the action publish `0.2.0-rc.1`, and so on.
8. Promote to 0.2.0. `pnpm changeset pre exit`, commit `.changeset/pre.json` removal, push to `main`. The action opens a version PR that bumps `0.2.0-rc.N` to `0.2.0`; merge it and the action publishes under `latest`. Then tag/GitHub release is created by the action; do not tag by hand.
9. Post-release: confirm `latest` points to `0.2.0` for all 11 packages, update the compat site data if the numbers changed.

## Open exit criteria

Found by the rehearsal on this branch (all real, none fixed here, scope was release plumbing only):

- [x] Consumers cannot bundle `@bolojs/registry` or `@bolojs/vite-server` in a clean Vite app: `oxc-transform/browser.js` imports `@oxc-transform/binding-wasm32-wasi`, which is not installed for consumers (the repo has a pnpm patch for it, `patchedDependencies` do not travel with published packages). The rehearsal works around it with `pnpm add @oxc-transform/binding-wasm32-wasi@0.140.0`; `REHEARSAL_STRICT_OXC=1` reproduces the failure. Fixed: `@oxc-transform/binding-wasm32-wasi@0.140.0` is now a dependency of `@bolojs/registry` and `@bolojs/vite-server`; the rehearsal is strict by default (`REHEARSAL_WORKAROUND_OXC=1` restores the old manual install).
- [x] Other patched dependencies (`@rolldown/browser@1.1.5`, `unenv@2.0.0-rc.24`) are also not applied for consumers. Fixed: the unenv assert fix ships as a transform in the `nodeWebShims()` Vite plugin, and the oxc/rolldown WASI `asyncWorkPoolSize` fix as a transform in `@bolojs/vite-preset` (`bolojsShimPlugins()`). The rehearsal asserts both are applied in a consumer bundle. Consumers who do not use the preset or plugin must apply them themselves.
- [x] Compiled test files are published (`dist/**/*.test.js`, 229 files in the dry-run). Excluded via `files` negations.
- [ ] `dist` uses extensionless relative imports (`./registry`, `./crypto`). Fine for bundlers, fails in plain Node ESM (`Cannot find module .../dist/registry`). Acceptable only if the packages are documented as bundler-only.
- [x] Every package has a `README.md` (listed in `files`, with a bundler-only note where it applies). A `LICENSE` is now copied into each package.
- [ ] Consumers installing with pnpm 10 hit `ERR_PNPM_IGNORED_BUILDS` for `@mongodb-js/zstd` and `node-liblzma` (transitive through `@bolojs/pm` lockfile parsing). Document `onlyBuiltDependencies` or drop the native deps.
- [ ] `@bolojs/node-web-shims` ships `unenv` pinned to a prerelease (`2.0.0-rc.24`); acceptable for rc, decide for 0.2.0.

Process model checks (from the brief; confirm against the plan):

- [ ] Differential runner green on the merged result: `cd apps/compat-harness && pnpm exec vite --port <PORT>`, then `pnpm exec tsx tests/differential/run.ts --url http://localhost:<PORT> --count N --seed S --out file.json`.
- [ ] `pnpm validate` (typecheck, lint, format, test) green on merged `main`.
- [ ] Docs (`api`, `compat`, `migration`) describe worker-per-process, real `kill()`, exit codes, event-loop liveness.
- [ ] Compat numbers on the site regenerated after the merge.

Release plumbing (done on `v020/publish-rc`):

- [x] rc pre mode entered, `.changeset/process-model.md` added, `initial-public-release.md` kept; all 11 packages resolve to `0.2.0-rc.0`.
- [x] All 11 packages have `license` (Apache-2.0), `repository` with `directory`, `publishConfig.access=public`, `files: ["dist"]`, `main`/`types`. Packed tarballs contain no `workspace:` specifiers; internal deps become exact versions.
- [x] Rehearsal script and guarded CI dry-run job.

## NPM_TOKEN and provenance

- `NPM_TOKEN` (repo secret, used by `.npmrc` as `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`): an npm automation or granular access token with read and write on the `@bolojs` scope and the `bolojs` package, 2FA bypass for automation. The `@bolojs` org and the unscoped `bolojs` name must exist and be owned by the publisher before the first publish. First publish of a new package needs the scope to exist; `access: public` is set in the changeset config and `publishConfig`.
- Provenance: `NPM_CONFIG_PROVENANCE=true` plus `permissions: id-token: write` are already in `release.yml`. Provenance only works from GitHub-hosted runners, on a public repo, and each `package.json` `repository.url` must match the repo (`git+https://github.com/bolojs/bolo.git`, already set). A mismatch makes the publish fail with a provenance error.
- Optionally move to npm trusted publishing (OIDC) and drop the long-lived token once the packages exist on the registry.
- The `dry-run` job intentionally has neither `NPM_TOKEN` nor `id-token: write`.
- Also required: `GITHUB_TOKEN` write access to contents and pull requests (set in the workflow), and the repo setting "Allow GitHub Actions to create and approve pull requests".
