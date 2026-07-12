---
title: Package Manager Support
description: npm, yarn, pnpm, bun, JSR, and the browser-native package manager landscape.
sidebar:
  order: 6
---

Status of package installation and registry support in browser-containers,
plus an exploration of which package managers and registries we can realistically
support in a browser-only runtime. The architectural decision is recorded in
[ADR-0004](/docs/adr/0004-package-manager-strategy/).

## Current state

npm works today via **npm-in-browser**: the real `npm/cli` source compiled to a
single ESM module with Node globals shimmed at build time. It uses `fetch()`
against `registry.npmjs.org` (CORS required), reads and writes
`package-lock.json`, and blocks install scripts. It is not a reimplementation
of npm, it is the real CLI.

This is the baseline. Everything below is evaluated relative to it.

## Registries

### npm registry

Fully supported via npm-in-browser. Tarballs resolve against
`registry.npmjs.org` and install into the virtual filesystem.

### JSR (jsr.io)

**Feasible, ~1 day of work, high ROI.**

JSR is the Deno team registry for native TypeScript packages. It exposes an
npm-compatibility layer at `npm.jsr.io`: every package is mirrored there as
`@jsr/scope__name` (double underscore) under the standard npm registry
protocol (corgi install manifests, tarballs). The mapping from a
`jsr:@scope/name` specifier to `@jsr/scope__name` is a pure syntactic
transform. There is no JSR-specific install API beyond this.

Bringing tier-1 JSR support requires:

1. Write `@jsr:registry=https://npm.jsr.io` to `.npmrc` so npm-in-browser
   resolves `@jsr/*` scopes against the JSR mirror.
2. Fix `parsePackageSpecifier` (`packages/npm/src/package-manager.ts`) so a
   `jsr:` specifier emits `@jsr/scope__name` instead of `@scope/name`.
3. Add a bundler `jsr:`-alias plugin (mirrors the existing node-alias plugin
   in `packages/wasm-registry/src/bundle.ts`) so `import "jsr:@foo/bar"`
   rewrites to the installed `@jsr/foo__bar` package.

Publishing to JSR is out of scope for a browser runtime.

## Package manager CLIs

The central question: can we run the real CLI for other package managers
(yarn, pnpm, bun), the way npm-in-browser runs the real npm CLI?

### yarn v1

**Feasible via lockfile translation (~1 day).** Running the real yarn CLI
needs a virtual symlink table so its `node_modules` walker resolves layouts.
Translation of `yarn.lock` into an installed graph is cheaper and avoids
ongoing maintenance.

### pnpm

**Impossible without a re-architecture.** Two structural blockers:

1. The content-addressable store hardlinks packages via `fs.linkSync`. The
   browser Filesystem Access API and OPFS have no hardlink concept.
2. The virtual store is 100% symlinks (`symlinkDir`). The `node-linker=hoisted`
   option changes strategy *within* the isolated layout, it does not eliminate
   symlinks.

pnpm lockfile translation (~1 day) gives the same installed graph without the
CLI.

### bun

**Infeasible.** The blocker is not the language. Bun migrated its installer
from Zig to Rust in v1.4.0, but the underlying `bun_sys` calls `libc` syscalls
with no WASI equivalent: `clonefile`/`hardlink`/`symlinkat`,
`connect`/`recv` (TCP, where WASIp1 sockets are UDP-only), and `futex`. There
is no JS API for install (only a `parseLockfile` test helper). It cannot run
under our WASI shim, which provides filesystem, args, and env only.

## Browser-native package manager candidates

We evaluated every candidate that claims browser or cross-runtime viability.
None is adoptable today. The table records why.

| Candidate | Status | Browser-viable? | Why not |
|-----------|--------|-----------------|---------|
| **aube** (`jdx/aube`) | Active, MIT, ~weekly releases | No | Rust CLI with no WASM target, `rayon` sync threadpool, `reqwest` HTTP. Materialize cascade uses clonefile/hard_link/copy, linker uses symlinks. Best-in-class lockfile story (reads/writes pnpm, npm, yarn, bun locks in place) but a browser port means a WASM build, async rewrite, and fetch swap. |
| **nubjs** (`nubjs/nub`) | Wrapper | No | CLI wrapper around aube. No independent implementation. |
| **pacquet** (`pnpm/pacquet`) | Dead, archived May 2026 | No | Merged into the pnpm monorepo. Rust CLI, no WASM, undici HTTP. Its fs crate has no hardlink module (symlink-only), which is more browser-friendly than pnpm, but there is no virtual store so no cross-project dedup. Dead code. |
| **vsr** (`vltpkg/vsr`) | Active | Wrong category | A serverless registry runtime (Cloudflare Workers/Pages), not a package manager. |
| **vltpkg** (`vltpkg/vltpkg`) | Active, rc | No (as a PM) | Clean layered architecture, but `@vltpkg/registry-client` wraps undici (Node-only), `@vltpkg/cache` hardlinks to a sha512 CAS, and `@vltpkg/graph` reify creates symlinks. All three are browser blockers. The engine, however, is reusable (see below). |
| **rnpm** (`r2hu1/rnpm`) | Abandoned, 2 stars | No (alone) | Rust CLI, no WASM. Its extraction model is the cleanest browser-compatible design found: `fs::rename` or `fs::copy` into node_modules, no symlinks, no hardlinks, no virtual store, no dedup. Hardcoded registry URL and abandoned. Useful as a reference only. |

The single largest blocker across all candidates is **server-only HTTP**:
every Rust-based candidate uses `reqwest` or `undici`, neither of which runs in
a browser without a full rewrite to `fetch`.

## Supporting libraries

These are not package managers, but libraries that could feed into our install
or resolution layer.

### vlt engine (`@vltpkg/*`)

**Strongest candidate for resolver and install-logic reuse.** The vltpkg graph
engine is separately importable, and browser variants exist:
`@vltpkg/spec/browser`, `@vltpkg/graph/browser`, `@vltpkg/dep-id/browser`,
`@vltpkg/security-archive/browser`. The public API (`actual.load()`,
`ideal.build()`, `reify()`, `install()`) takes a `scurry` filesystem
abstraction, a `packageInfo` manifest fetcher, and a `packageJson` reader.

Graph computation (actual, ideal, diff) is link-format-agnostic. The only
filesystem coupling is in `reify`, which writes the `node_modules` layout. The
`@vltpkg/cache` hardlink CAS and the `@vltpkg/registry-client` undici wrapper
are the blockers, but both are skippable if we supply our own `scurry` adapter
backed by VfsBus and our own fetch-based registry client.

The `scurry` interface is not documented in the public docs. Read the source
for the type contract before committing to this path.

### `@jspm/generator`

**Possible replacement for the esm.sh resolver plugin.** A browser-runnable
import-map generator that traces dependency graphs, resolves `exports` and
`imports` with environment conditionals (browser, module, development,
production), and outputs WICG import-map JSON. It supports a `customResolver`
per specifier and an `inputMap` that acts as a lockfile.

It does **not** support JSR specifiers. If we adopt it, JSR handling stays
separate. A conservative adoption path keeps esm.sh as the CDN provider behind
a custom resolver. Apache-2.0, active.

### `@yarnpkg/fslib`

**Useful as an adapter pattern, not as a symlink emulator.** Pure TypeScript,
BSD-2-Clause, no native dependencies, 100% browser-viable. Its `FakeFS`
abstract class, `ProxiedFS` adapter (implement `mapToBase`/`mapFromBase` and
inherit delegation), and `patchFs` runtime patcher are clean primitives.

However, `VirtualFS` does **not** emulate symlinks. It is a path-mapping layer
for the Yarn PnP `$$virtual` scheme. `symlinkSync`/`readlinkSync`/`lstatSync`
all proxy through to the base filesystem unchanged. There is no hardlink
emulation anywhere in fslib. Vendoring it does not solve the symlink problem;
the 20-line fix of forwarding memfs Volume internals through the fs API solves
80% of what fslib would.

### pkg.pr.new

**Secondary, CI-only tarball source.** A StackBlitz Labs platform that runs a
GitHub Action to `npm pack` a package at a given commit, PR, or branch, then
serves the `.tgz` from Cloudflare R2 at `pkg.pr.new/{owner}/{repo}/{pkg}@{ref}`.
It is not a CDN: it serves tarballs, no transpilation, no ESM rewriting.
esm.sh already consumes it via a `/pr/` endpoint.

Integration value is as an additional URL-tarball dependency source for
previewing PR builds. It requires a GitHub App and workflow on the source repo,
so end users cannot publish locally. MIT, adopted by Vite, Vue, Svelte, Nuxt,
Biome. No published SLA or rate limits.

## The symlink and hardlink blocker

Everything above converges on one root cause: **the browser filesystem (memfs
plus OPFS) has no symlink or hardlink semantics.** This gates:

- the real pnpm CLI (hardlinks plus symlink virtual store),
- the real yarn v1 CLI (needs to walk symlinked node_modules),
- vltpkg `reify()` (writes node_modules layout with symlinks),
- `@yarnpkg/fslib` (proxies symlink ops to the base filesystem).

The fix is small and local: forward memfs Volume's internal `symlinkSync`,
`readlinkSync`, and `lstatSync` to the public `fs` API (roughly 20 lines).
memfs already implements these internally, they are just not exposed. Once that
exists, yarn v1 lockfile translation, vlt engine `reify`, and fslib `patchFs`
integration all become viable.

Hardlinks (needed by pnpm's CAS and vltpkg's `@vltpkg/cache`) require a
separate in-memory inode table. There is no shortcut here. This is why pnpm
remains lockfile-translation-only even after the symlink work lands.

## WinterTC positioning

WinterCG, now formalized as Ecma TC55 and [ECMA-429][ecma429], defines the
minimum common Web API surface that every non-browser JavaScript runtime agrees
to provide. We are already roughly 90% compliant through native Web APIs plus
`node-web-shims`.

Marketing a measurable WinterTC compliance percentage is worthwhile as a tier
label between Web-Standard and full Node. Deno markets "WinterCG-compliant"
and Bun markets "web-interoperable". The official test suite (a WPT subset) is
not yet published, so any claim should be hedged as "ECMA-429 2025
snapshot-aligned" until a runnable suite exists. See
[compat.md](/docs/compat/#t2-wintertc-minimum-ecma-429).

[ecma429]: https://min-common-api.proposal.wintertc.org/

## Decision

See [ADR-0004](/docs/adr/0004-package-manager-strategy/) for the formal record.
In short: keep npm-in-browser, add JSR via `npm.jsr.io`, add lockfile
translation for yarn and pnpm, build the symlink table on memfs, and defer a
browser-native package manager until install performance becomes a real pain
point.

## Roadmap (priority order)

Worked items here are exploration conclusions, not committed tasks. The
implementation roadmap will be tracked in the GitHub Project.

1. **JSR tier-1** (~1 day): fix `parsePackageSpecifier`, add `.npmrc` entry,
   add bundler `jsr:`-alias plugin.
2. **Lockfile translation** (~1 day each for yarn and pnpm): no new deps,
   high adoption value.
3. **Symlink table on memfs** (~2 to 3 days): forward memfs internals through
   the fs API. Unlocks yarn v1, vltpkg `reify`, fslib `patchFs`.
4. **WinterTC compliance audit** (~1 day): close `navigator.userAgent` and
   rejection-event gaps, publish a percentage against ECMA-429.
5. **Browser-native package manager** (deferred, ~2 to 3 weeks): only if
   install performance becomes a user pain point. Reference rnpm's extraction
   model (copy and rename, no symlinks or hardlinks) and aube's lockfile
   handling. Build on fetch and VFS primitives.

Explicitly skipped: real npm CLI port (~2 to 3 weeks plus perpetual per-version
maintenance), real pnpm CLI (impossible), bun install (infeasible), wholesale
adoption of aube or pacquet.
