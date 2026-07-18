# ADR-0005: Unified Multi-Format Lockfile Compatibility (`@unjs/lockfile`)

## Status

Implemented — supersedes the package manager section of [ADR-0004](0004-package-manager-strategy.md). The `browser-native` install strategy is now the default and the only strategy. The `npm-in-browser` dependency has been fully removed. Tarball decompression uses the native `DecompressionStream` Web API (replacing `pako`). Integrity is verified via `crypto.subtle`. Packument responses are cached in the VFS (7-day TTL) to avoid repeated registry round-trips.

## Context

[ADR-0004](0004-package-manager-strategy.md) established the layered PM strategy: keep npm-in-browser, add JSR via `npm.jsr.io`, add lockfile translation for yarn and pnpm, build the symlink table on memfs, and defer a browser-native package manager. That ADR was made before aube's lockfile architecture was studied in depth, before `bun.lock` (text, bun 1.1+) was confirmed trivially parseable, before `@hyrious/bun.lockb` was identified as a full JS bun.lockb parser, and before the `unpm` naming collision on npmjs.org was discovered.

This ADR updates and supersedes the PM section of ADR-0004, keeping the overall direction but replacing the per-format translation approach with a **single, unified, format-agnostic lockfile compatibility layer** inspired by aube's IR design, now scoped as a standalone, framework-agnostic unjs package named **`@unjs/lockfile`**.

The bolo monorepo is the primary consumer and co-steward of `@unjs/lockfile`, not its owner.

---

## Decision

### 1. Build `@unjs/lockfile` as a standalone unjs package

`@unjs/lockfile` is a new package that reads any of the four major lockfile formats (npm `package-lock.json`, yarn v1 `yarn.lock`, pnpm `pnpm-lock.yaml`, bun `bun.lock` / `bun.lockb`) and produces a **normalized `LockfileGraph`** — a format-agnostic dependency graph that a fetch-backed installer can materialize into `node_modules`.

**Architecture:**

```
LockfileGraph        # IR — canonical dep graph
  ├── LockedPackage  # per-package: name, version, dep_path, resolved URL, integrity
  ├── CatalogEntry   # pnpm v9 catalogs
  └── LockfileMeta   # format, version, settings

Format adapters (one per format):
  NpmAdapter    ← reads package-lock.json v1/v2/v3 via lockparse
  YarnAdapter   ← reads yarn.lock v1 + berry via @yarnpkg/lockfile + @yarnpkg/parsers
  PnpmAdapter   ← reads pnpm-lock.yaml v9 via @pnpm/lockfile-file (read-only subset)
  BunAdapter    ← reads bun.lock (JSONC) directly; bun.lockb via @hyrious/bun.lockb

Resolver:
  lockfileGraph.packages
    → filter by importer (workspace root or specified workspace)
    → extract name@version + resolved tarball URL + integrity
    → return InstallablePackage[]
```

**Package name:** `@unjs/lockfile` (not `unpm` — `unpm` is taken on npmjs.org by an abandoned 2014 package; `@unjs/unpm` requires unjs org approval; `@unjs/lockfile` is the safer, more descriptive name).

**Design principles:**
- Zero Node:\* builtins. Pure `fetch` + `Response` + `ArrayBuffer` for network. Pure `ArrayBuffer` + `TextDecoder` + `JSON` for parsing. No `fs`, no `path`, no `child_process`.
- MIT license throughout. All format parsers are MIT/BSD-2/ISC/Apache-2.0 — no GPL conflicts.
- Published on npm as `@unjs/lockfile`. Consumable by any tool (unjs ecosystem, Deno, Bun, Node, browser).
- The IR shape is modeled after aube's `LockfileGraph`/`LockedPackage` (MIT, `jdx/aube`) — a clean-room reimplementation, not a fork.

**Key format facts (from research):**

| Format | Parser | Browser-viable? | Notes |
|--------|--------|-----------------|-------|
| `package-lock.json` v2/v3 | `lockparse` (MIT, zero-dep) | YES | All lockfileVersion values |
| `yarn.lock` v1 | `@yarnpkg/lockfile` (BSD-2) | YES | Stable since 2017, pure JS |
| `yarn.lock` berry v2+ | `@yarnpkg/parsers` (BSD-2, extractable) | YES | Detected by `__metadata:` peek |
| `pnpm-lock.yaml` v9 | `@pnpm/lockfile-file` read-only (MIT) | PARTIAL | YAML parsing is browser-safe; dep_path parsing is portable |
| `bun.lock` (text, bun 1.1+) | Native `JSON.parse()` | YES | JSONC — strip trailing commas first |
| `bun.lockb` (binary, bun <1.1) | `@hyrious/bun.lockb` (MIT) | YES | TypeScript translation of bun's Zig deserializer; outputs yarn.lock text, then re-parse |

### 2. Integrate `@unjs/lockfile` into `packages/npm`

**Current state:** `PackageManager.install()` calls `runNpmCli(args, { fs })` from `npm-in-browser` directly. There is no abstraction interface.

**Change:** Refactor `PackageManager` to accept an optional `installStrategy`:

```typescript
// New option in PackageManagerOptions
installStrategy?: 'npm-in-browser' | 'lockfile-only' | ((ctx: InstallContext) => Promise<void>)

// InstallContext
interface InstallContext {
  lockfileGraph: LockfileGraph          // from @unjs/lockfile
  vfs: VfsBus
  cwd: string
  stdout: OutputCallbacks['stdout']
  stderr: OutputCallbacks['stderr']
}
```

- `'npm-in-browser'` (default): calls `runNpmCli` as today — unchanged for npm-native users.
- `'lockfile-only'`: reads the detected lockfile via `@unjs/lockfile`, computes `InstallablePackage[]`, then fetches each tarball via `fetch()` + writes to VFS. No npm CLI involvement.
- `((ctx) => Promise<void>)`: custom strategy (enables future extensibility).

The `'lockfile-only'` path is the primary deliverable. It is strictly better than running the real CLI because:
- It works with any of the four lockfile formats
- It runs entirely in-browser with `fetch` (no CLI process spawn)
- It does not need `fs.symlink` or `fs.hardlink` to produce a working `node_modules`

**Bundler path is unchanged** — `bundleEntry`, the VFS plugin, and the node-alias plugin are unaffected by the PM change.

### 3. Add JSR tier-1 support (carry forward from ADR-0004)

The `jsr:` specifier handling from ADR-0004 remains valid and is incorporated here. The two changes needed (neither is done yet per codebase recon):

1. **`packages/wasm-registry/src/bundle.ts`**: add a `jsrAliasPlugin` — rewrites `import "jsr:@foo/bar"` to the installed `@jsr/foo__bar` package. Does not exist in code today.
2. **`packages/npm/src/package-manager.ts` `parsePackageSpecifier`**: already handles `jsr:` at install time (line :96). No code change needed there.

The JSR install path uses `npm.jsr.io` as the npm-compatibility mirror, written to `.npmrc`.

### 4. Build the symlink table on memfs (carry forward from ADR-0004)

memfs `Volume` implements `symlinkSync`/`readlinkSync`/`lstatSync` internally but does not forward them through the public fs API. The fix is ~20 lines in `packages/node-runtime-shims/src/fs-shim.ts`: forward `vfs.hot.symlinkSync`/`readlinkSync`/`lstatSync` to the returned object.

This unblocks yarn v1 lockfile translation (which writes symlinks into `node_modules`), the vlt engine `reify()` step, and `@yarnpkg/fslib` integration.

**Hardlinks remain unsupported.** pnpm's on-disk CAS and vltpkg's `@vltpkg/cache` require `fs.linkSync`, which OPFS and the Filesystem Access API cannot provide. This is a permanent architectural constraint.

**Update (ADR-0008):** the sentence below this note originally read "pnpm lockfile translation will always produce a copy-based layout" and the Consequences section below originally said hardlink-dependent dedup was "permanently unsupported." Both are now outdated. [ADR-0008](0008-virtual-store-resolver-and-cas.md) ships a symlink-based virtual store (true multi-version, pnpm-style installs, no copies) and a content-addressed cold-storage layer (dedups identical file content across packages by hash, no hardlinks needed). The `fs.linkSync` gap itself is still real; the dedup and layout outcomes it was assumed to block are not.

### 5. Bun lockfile feasibility (new in this ADR)

ADR-0004 said bun install was infeasible (libc syscalls). This is confirmed: bun's CLI is not runnable in-browser.

However, **bun lockfile reading IS feasible**, contrary to what ADR-0004 implied:

- `bun.lock` (text, bun 1.1+, JSONC): trivially parseable with `JSON.parse()` after stripping trailing commas. Supported by `lockparse` and `@hyrious/bun.lockb`.
- `bun.lockb` (binary, bun <1.1): `@hyrious/bun.lockb` (MIT, hyrious) is a complete TypeScript port of bun's Zig deserializer — zero deps, browser-runnable. It produces yarn.lock v1 text, which is then re-parsed via `@yarnpkg/lockfile`. This two-step path covers all bun.lockb versions.

bun lockfile *writing* (producing a bun.lock after install) is out of scope for bolo v1.

### 6. Position WinterTC (ECMA-429) compliance as a tier label

WinterCG (Ecma TC55, ECMA-429) formalizes the minimum common Web API surface. bolo is approximately 85-90% compliant through native Web APIs plus `node-web-shims`. The `navigator.userAgent` and `unhandledrejection` gaps are each closable in under 20 lines.

Once the WPT subset test suite is published (ongoing as of late 2025 per WinterTC55 issues), we can publish a compliance audit and market a precise percentage against the ECMA-429 2025 snapshot.

## Alternatives Considered

- **Port the real npm CLI.** Rejected. Needs a fetch-backed `ClientRequest` shim, `fs.symlink`/`readlink`/`lstat` exposure, and perpetual per-version maintenance. Lockfile translation gives the same installed graph with ~5% of the effort.
- **Run the real pnpm CLI.** Rejected as impossible. Hardlinks in the CAS and 100% symlink virtual store are structural.
- **Run the real yarn v1 CLI.** Feasible but inferior to lockfile translation. Needs the symlink table plus `ClientRequest`. Translation gives the same graph with less work.
- **Run bun install.** Rejected as infeasible. The blocker is `libc` syscalls with no WASI equivalent. Bun lockfile *reading* is adopted (see §5 above).
- **Adopt aube wholesale.** Rejected. Best-in-class lockfile story but a browser port requires a WASM build, `rayon`-to-async rewrite, and `reqwest`-to-`fetch` swap, against a project that releases ~bi-weekly. A clean-room JS reimplementation of the IR shape is lower risk and produces a reusable unjs package.
- **Adopt `@vltpkg/graph` as the resolver IR.** Partially adopted. `@vltpkg/spec` and `@vltpkg/dep-id` are reusable (MIT, browser-compatible). The full graph engine depends on `graph-run`, `cmd-shim`, and `security-archive` — Node:\* heavy. The `@unjs/lockfile` IR is built from scratch using aube as the design reference.
- **Name the package `unpm` instead of `@unjs/lockfile`.** Rejected. `unpm` is taken on npmjs.org by an abandoned 2014 package (`hayes/unpm`). `@unjs/unpm` requires unjs org approval. `@unjs/lockfile` is descriptive, collision-free, and clearly belongs to the unjs ecosystem.

## Consequences

- Users with `bun.lock`, `pnpm-lock.yaml`, or `yarn.lock` projects can drop them into bolo without converting to npm — `@unjs/lockfile` reads the existing lockfile and `PackageManager` with `'lockfile-only'` strategy installs from the resolved tarball URLs.
- `@unjs/lockfile` is a reusable, framework-agnostic unjs package. It can be published independently, cited in the unjs ecosystem, and consumed by Deno, Bun, Node, or any runtime that needs lockfile-to-graph translation.
- The symlink table (memfs forwarding) is the single dependency that unlocks several downstream capabilities and should be prioritized immediately.
- Hardlink-dependent features specifically (an on-disk CAS built on `fs.linkSync`, vltpkg's `@vltpkg/cache`) remain permanently unsupported due to browser filesystem constraints. The *dedup outcome* those features chase is not permanently unsupported: [ADR-0008](0008-virtual-store-resolver-and-cas.md) achieves it via content-addressed cold storage instead of hardlinks.
- Install performance and disk usage in the VFS will be worse than a native hardlinking PM, though ADR-0008's content-addressed cold storage narrows the disk-usage gap by deduping identical file content across packages.
- WebContainers (StackBlitz) runs real CLIs via WASM Node.js but requires a commercial license for production use and is architecturally incompatible with the fetch-only/memfs-only constraints of bolo. The lockfile-translation approach is the correct architectural choice for a browser-native FOSS project.
