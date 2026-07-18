# ADR-0008: Virtual-Store Resolver and Content-Addressed Cold Storage

## Status

Implemented — updates the `node_modules` layout produced by `@bolojs/npm` and the cold-storage format in `@bolojs/vfs-bus`. Corrects the framing in [ADR-0005](0005-package-manager-strategy.md) §4 and its Consequences section: those sections state that pnpm-style installs would "always produce a copy-based layout" and that dedup was "permanently unsupported" without hardlinks. Both claims are now outdated. `fs.linkSync` is still unavailable in OPFS/the Filesystem Access API and real hardlinks remain impossible, but this ADR ships (1) a symlink-based virtual store that gives true multi-version, pnpm-style installs without hardlinks, and (2) content-addressed cold storage that dedups identical tarball bytes across packages without hardlinks either. The dedup goal ADR-0005 wrote off is achieved through a different mechanism.

## Context

`PackageManager`'s installer (both `lockfile-only` and `browser-native` strategies) resolved every dependency to a single flat `node_modules/<name>` entry, keyed only by package name. This caused three real problems:

1. **Diamond dependencies silently collapsed.** If `pkgA` needed `shared@1.5.0` and `pkgB` needed `shared@2.0.0`, only one version survived in `node_modules`, and the other package got whichever version won the race — a correctness bug, not a cosmetic one.
2. **No peer dependency resolution.** React-family packages needing a peer-linked `react`/`react-dom` had to be special-cased directly in `package-manager.ts` (`REACT_DEPENDENT_PACKAGES` / `EXTERNALIZED_PEER_DEPS`) because there was no general mechanism.
3. **No `.bin` support**, and no tolerance for optional dependencies that fail to fetch (one flaky optional dep failed the whole install).

Separately, the cold OPFS/IndexedDB layer stored every file at its literal path with no dedup: two packages shipping byte-identical files (a common case — license files, small shared vendored code, near-duplicate versions) each paid the storage cost in full.

**Key finding that unblocked this work:** `memfs` (the VFS hot layer) already forwards `symlinkSync`/`readlinkSync`/`lstatSync` end-to-end (shipped per ADR-0005 §4), and the bundler's `findPackageDir` already walks through symlinked ancestors via a classic parent directory search. That means a pnpm-style symlinked virtual store was buildable entirely on existing browser-storage primitives — no new capability was needed for the resolver, only for cold-layer dedup.

## Decision

### 1. Virtual store, not a flat `node_modules`

`packages/npm/src/virtual-store.ts` materializes every resolved package into its own store directory, keyed by `name@version`, then symlinks it into place:

```
node_modules/.bolo/<name>@<version>/node_modules/<name>/...   # real, fetched contents
node_modules/<name>                                            # symlink -> store dir (root deps)
node_modules/.bolo/<parent>@<v>/node_modules/<dep>              # symlink -> store dir (transitive deps)
```

This is the same trick pnpm uses on a real filesystem, ported to memfs symlinks. Two versions of `shared` now coexist as two separate store directories, each linked in from whichever parent package actually depends on that version — diamond dependencies are resolved correctly instead of collapsing to one winner.

Consuming this from a lockfile or a fresh registry resolve both go through the same `ResolvedGraph`/`ResolvedGraphPackage` shape (`@unjs/lockfile`'s `resolveGraph()` for the lockfile path, `walkDependencies()` for the registry-walk path), so the materializer has one code path regardless of install strategy.

### 2. Bundler fix: realpath resolved module ids

Making the virtual store actually work through the bundler required one real code change, not zero (ADR-0005's assumption that bundler compatibility needed only "verify, likely no change" was optimistic). `packages/wasm-registry/src/bundle.ts`'s `resolveFile()` returned the raw symlinked candidate path. Real Node.js calls `fs.realpathSync` on resolved module ids by default (unless run with `--preserve-symlinks`) specifically so a package resolved through a symlink still does its own further `node_modules` lookups from its real, nested store directory rather than the symlink's flat location. Without this, a plain string `dirname()` parent-walk (used to find `node_modules` ancestors) walks the symlink's flat logical ancestry and never finds sibling packages that live in the real nested store directory. `resolveFile()` now calls `vfs.hot.realpathSync()` on every resolved candidate, matching Node's default behavior. Verified with a cross-package integration test (`materializeVirtualStore` + `bundleEntry`) that bundles a real diamond-dependency app and asserts both versions' distinguishing content is present in the output.

### 3. Best-effort peer dependency resolution

For each package's declared `peerDependencies`, the materializer searches the whole resolved graph (via `semver`'s `maxSatisfying`/`satisfies`) for any package with a matching name and satisfying version, and symlinks it in if found; otherwise it warns "unmet peer dependency" and continues. This is deliberately simpler than pnpm's real per-consumer peer-suffixed depPath variants (which would require re-resolving depPath keys per unique peer combination) — a graph-wide best-effort search covers the common case (a single version of a peer like `react` satisfying everyone) without that complexity. The `REACT_DEPENDENT_PACKAGES`/`EXTERNALIZED_PEER_DEPS` hacks in `package-manager.ts` were kept: they concern esm.sh CDN import-map externalization, an orthogonal subsystem to local `node_modules` peer linking, not a workaround this ADR obsoletes.

### 4. `.bin` linking and optional-dependency tolerance

`.bin/<name>` entries are symlinked at both the root `node_modules/.bin` and each package's own `node_modules/.bin`, matching real pnpm/npm behavior (not just root-level, which the original plan wording left ambiguous). A failing optional dependency's fetch is caught and warned about; dependent edges pointing at it are skipped rather than failing the whole install.

### 5. Nested lockfile-writer output (npm v3 compatible)

`packages/npm/src/lockfile-writer.ts` now takes a `ResolvedGraph` instead of a flat package array. Root dependencies are always placed flat at `node_modules/<name>`; a transitive dependency tries to reuse that same flat slot first (if it is the same resolved package, or the slot is empty) and only nests under its requiring parent's path (`node_modules/<parent>/node_modules/<dep>`) on a genuine version conflict. A cycle guard (`ancestors: Set<string>`) prevents runaway nesting on graph cycles with alternating conflicting versions. This keeps the common case (no conflicts) flat and npm-v3-idiomatic, while still producing a structurally valid, re-resolvable lockfile for the diamond-dependency case.

### 6. Content-addressed cold storage

`packages/vfs-bus/src/cas.ts` implements the dedup algorithm as a pure, backend-agnostic class (`CasStore`), unit tested directly against an in-memory backend. `packages/vfs-bus/src/opfs-worker-script.ts` (the actual code that runs inside the browser Worker) implements the same algorithm inline, since a classic Blob-constructed Worker script cannot import a module — the two are kept in sync by hand and both are covered by tests (`cas.test.ts` against the pure algorithm; `opfs-worker-script.test.ts` executes the real worker script source against a minimal in-memory IndexedDB fake, to catch drift between the two).

The scheme:
- A manifest maps logical path → blob hash (`sha256`, via `crypto.subtle.digest`); a directory is represented as an explicit `null` manifest entry or implied by any deeper path under it.
- A blob is stored once per unique hash; a refcount per hash tracks how many paths reference it. `writeFile` increments the new hash's refcount (storing the blob only if this is the first reference) and decrements the previous hash's refcount if the path already had different content, deleting the blob once its refcount reaches zero.
- **Migration:** pre-CAS installs wrote raw bytes directly at their literal path (no manifest, no hashing). Those are treated as a "legacy" store and lazily migrated: a `readFile` miss in the manifest falls back to a legacy read, and on success both migrates the content into CAS and removes the legacy copy. `exists`/`readdir` also consult the legacy store so unmigrated data stays visible until it is first read. No upfront migration pass is needed.

This gives the same practical benefit as pnpm's hardlink-based store (byte-identical files stored once) without needing `fs.linkSync`, which OPFS and the Filesystem Access API still do not provide.

## Scope boundaries

Explicitly out of scope, matching the original ADR-0005 boundary and not revisited here: lifecycle scripts (`postinstall` etc.), workspaces/monorepo-aware installs, and git/file/http dependency specifiers.

## Alternatives Considered

- **Real hardlinks for cold-layer dedup.** Rejected — still impossible; OPFS and the Filesystem Access API have no `fs.linkSync` equivalent. Content-addressed storage gets the same storage-dedup outcome through a different mechanism.
- **pnpm's real per-consumer peer-suffixed depPath variants.** Rejected for this iteration in favor of a simpler graph-wide best-effort peer search — correct for the common single-peer-version case, at a fraction of the resolver complexity. Can be revisited if a real-world project needs true per-consumer peer variants.
- **Eager upfront migration of legacy cold-storage data to CAS.** Rejected in favor of lazy, read-through migration — avoids a slow blocking pass over potentially large existing installs, and converges to fully-migrated storage naturally as files are read.

## Consequences

- Diamond dependencies (multiple versions of the same package name) now install and resolve correctly through the bundler, instead of silently collapsing to one version.
- Peer dependencies resolve automatically in the common case, removing the need for further special-casing beyond the existing esm.sh externalization list.
- `.bin` entries work per-package, not just at the root.
- Cold-layer storage is deduplicated by content hash, closing the gap ADR-0005 left open by declaring hardlink-based dedup permanently out of reach — the storage saving is achieved without hardlinks.
- The lockfile-writer's nested-placement algorithm is more complex than the previous flat-only version, but only engages on genuine version conflicts; the common flat case is unchanged.
- `opfs-worker-script.ts`'s CAS logic is duplicated (not shared via import) with `cas.ts`, because the former runs inside a classic Blob-constructed Worker with no module resolution. This duplication is a deliberate, documented trade-off, guarded by tests on both sides.
