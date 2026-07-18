# ADR-0004: Package Manager Strategy

## Status

Superseded (package manager section) by [ADR-0005](0005-package-manager-strategy.md). The WinterTC/ECMA-429 positioning and symlink table decisions remain valid.

## Context

bolo runs Node.js entirely in the browser with zero server
dependency. Today the only working package manager is **npm-in-browser**, the
real `npm/cli` source compiled to a single ESM module with Node globals shimmed
at build time. The question this ADR answers is how to extend package manager
and registry support beyond npm, given the browser's hard constraints.

The constraints are fixed by the environment:

- **No hardlinks.** OPFS and the Filesystem Access API have no `link` concept.
  This breaks any content-addressable store that dedupes via hardlinks.
- **No real symlinks.** memfs implements `symlinkSync`, `readlinkSync`, and
  `lstatSync` internally but does not forward them through the public `fs` API.
  This breaks any package manager that walks symlinked `node_modules` layouts.
- **`fetch` is the only network primitive.** There is no TCP client, so no
  `http.ClientRequest`. Every Rust CLI candidate uses `reqwest`; every modern
  npm-based PM uses `undici`. Neither runs in a browser without a rewrite.

We evaluated every package manager that claims browser or cross-runtime
viability: aube, nubjs, pacquet (dead), vsr (a registry, not a PM), vltpkg,
rnpm (abandoned), and bun (infeasible). We also evaluated reusable engines and
libraries (the vltpkg `@vltpkg/*` graph engine, `@jspm/generator`,
`@yarnpkg/fslib`) and additional registries (JSR, pkg.pr.new). The full
findings are in [package-managers.md](../package-managers.md).

The recurring conclusion is that running a real, non-npm CLI in the browser
either requires an infeasible amount of platform shimming (pnpm, bun) or
perpetual per-version maintenance for marginal gain (real npm CLI port with a
fetch-backed `ClientRequest`). WebContainers achieves real CLI execution
through a full-time-team-maintained in-browser OS simulation, which is not
replicable cheaply.

## Decision

Adopt a layered strategy that maximizes lockfile compatibility without porting
real CLIs:

1. **Keep npm-in-browser** as the primary installer.
2. **Add JSR tier-1 support** via the `npm.jsr.io` npm-compatibility registry.
   Fix `parsePackageSpecifier` to map `jsr:@scope/name` to
   `@jsr/scope__name`, write the `.npmrc` registry entry, and add a bundler
   `jsr:`-alias plugin.
3. **Add lockfile translation** for yarn v1 and pnpm. Translate the lockfile
   into an installed graph rather than running the real CLI. This gives the
   same result with roughly 10% of the effort and zero ongoing maintenance.
4. **Build a symlink table on memfs** by forwarding memfs Volume internals
   (`symlinkSync`, `readlinkSync`, `lstatSync`) through the public `fs` API.
   This unblocks yarn v1 lockfile translation, the vltpkg `reify` step, and
   `@yarnpkg/fslib` integration.
5. **Position WinterTC (ECMA-429) compliance** as a measurable tier between
   Web-Standard and full Node. Close the `navigator.userAgent` and
   rejection-event gaps and publish an audit.
6. **Defer a browser-native package manager** until install performance
   becomes a real user pain point. If and when we build one, base it on rnpm's
   extraction model (copy and rename into `node_modules`, no symlinks or
   hardlinks) and aube's lockfile handling, on `fetch` and VFS primitives.

## Alternatives considered

- **Port the real npm CLI.** Rejected. Needs a fetch-backed `ClientRequest`
  shim (roughly 300 to 500 lines of streaming) plus `fs.symlink`/`readlink`/
  `lstat` exposure, then perpetual maintenance for every new npm version.
- **Run the real pnpm CLI.** Rejected as impossible. Hardlinks in the CAS and
  a 100% symlink virtual store are structural, not optional.
- **Run the real yarn v1 CLI.** Feasible but inferior to lockfile translation.
  Needs the symlink table plus `ClientRequest`. Translation gives the same
  graph with less work.
- **Run bun install.** Rejected as infeasible. The blocker is `libc` syscalls
  with no WASI equivalent, not the implementation language. The Rust migration
  did not change this.
- **Adopt aube wholesale.** Rejected. Best-in-class lockfile story, but a
  browser port requires a WASM build, a `rayon`-to-async rewrite, and a
  `reqwest`-to-`fetch` swap, against a project that releases roughly weekly.
- **Adopt pacquet wholesale.** Rejected. Archived in May 2026 and merged into
  the pnpm monorepo. Dead code.
- **Adopt vltpkg as a PM.** Rejected as a full PM (`undici`, hardlink CAS,
  symlink reify). The graph engine is adopted in principle as a reusable
  library, pending a source read of the `scurry` interface.
- **Vendor `@yarnpkg/fslib`.** Rejected as a symlink emulator (it does not
  emulate symlinks). Its `ProxiedFS` adapter pattern and `patchFs` runtime
  patcher are noted as useful primitives, but the symlink problem is solved
  more cheaply by forwarding memfs internals.

## Consequences

- Users can install from npm and JSR, and consume yarn and pnpm lockfiles,
  without us maintaining real CLIs for each.
- The symlink table is the single dependency that unlocks several downstream
  capabilities. It should be prioritized.
- Hardlink-dependent features (pnpm CAS dedup, vltpkg `@vltpkg/cache`) remain
  unsupported. pnpm lockfile translation produces a copy-based layout, not a
  deduped one.
- Install performance and disk usage in the VFS will be worse than a native
  hardlinking PM until and unless we build the deferred browser-native PM.
- We carry no new runtime dependencies for package management. The vltpkg
  engine adoption, if it proceeds, is the one exception and is scoped to the
  resolver layer with our own `scurry` adapter.
