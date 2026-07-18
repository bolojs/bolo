import { maxSatisfying, satisfies } from "semver";
import type { VfsBus } from "@bolojs/vfs-bus";
import type { ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";

export interface MaterializeOptions {
  vfs: VfsBus;
  cwd: string;
  graph: ResolvedGraph;
  /** Fetch the tarball for `pkg` and extract it into `targetDir` (package.json lands at `targetDir/package.json`). */
  fetchAndExtract: (pkg: ResolvedGraphPackage, targetDir: string) => Promise<void>;
  onWarn?: (message: string) => void;
}

const storeDirFor = (cwd: string, pkg: ResolvedGraphPackage): string =>
  `${cwd}/node_modules/.bolo/${pkg.name}@${pkg.version}`;

const packageDirFor = (cwd: string, pkg: ResolvedGraphPackage): string =>
  `${storeDirFor(cwd, pkg)}/node_modules/${pkg.name}`;

const ensureParentDir = (vfs: VfsBus, path: string): void => {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !vfs.hot.existsSync(dir)) {
    vfs.hot.mkdirSync(dir, { recursive: true });
  }
};

/** Remove `path` if it's an existing symlink. `rmSync`/`existsSync` follow the
 * symlink target rather than acting on the link itself in memfs, so a stale
 * link survives `rmSync` and the next `symlinkSync` at the same path throws
 * EEXIST; `lstatSync` + `unlinkSync` operate on the link entry directly. */
const removeExistingLink = (vfs: VfsBus, path: string): void => {
  try {
    vfs.hot.lstatSync(path);
  } catch {
    return;
  }
  vfs.hot.unlinkSync(path);
};

const linkPackage = (vfs: VfsBus, linkPath: string, targetDir: string): void => {
  removeExistingLink(vfs, linkPath);
  ensureParentDir(vfs, linkPath);
  vfs.hot.symlinkSync(targetDir, linkPath, "dir");
};

/** Link every bin script of `edges`' targets into `<nodeModulesDir>/.bin/`. */
const linkBins = (
  vfs: VfsBus,
  nodeModulesDir: string,
  edges: Record<string, string>,
  packages: Map<string, ResolvedGraphPackage>,
  materialized: Set<string>,
): void => {
  for (const [depName, depKey] of Object.entries(edges)) {
    if (!materialized.has(depKey)) continue;
    const dep = packages.get(depKey);
    if (!dep) continue;
    for (const [binName, binRelPath] of Object.entries(dep.bin)) {
      const linkPath = `${nodeModulesDir}/.bin/${binName}`;
      const targetPath = `${nodeModulesDir}/${depName}/${binRelPath}`;
      ensureParentDir(vfs, linkPath);
      removeExistingLink(vfs, linkPath);
      vfs.hot.symlinkSync(targetPath, linkPath, "file");
    }
  }
};

/** Find a package in the graph whose name+version satisfies a peer's declared range. */
const findSatisfyingPeer = (
  packages: Map<string, ResolvedGraphPackage>,
  peerName: string,
  range: string,
): ResolvedGraphPackage | undefined => {
  const candidates = [...packages.values()].filter((p) => p.name === peerName);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const best = maxSatisfying(
    candidates.map((c) => c.version),
    range,
  );
  if (best) return candidates.find((c) => c.version === best);
  return candidates.find((c) => satisfies(c.version, range, { loose: true }));
};

/**
 * Materialize a pnpm-style virtual store in memfs (`vfs.hot`): every resolved
 * package gets its own directory under `node_modules/.bolo/<name>@<version>/`,
 * with dependency edges expressed as symlinks — so two packages requiring
 * different versions of the same dependency each get their own copy instead
 * of one silently winning (see `.agents/plans/2026-07-17-virtual-store-resolver.md`).
 *
 * Optional-dependency fetch failures are tolerated: the package and anything
 * that would have linked to it are skipped with a warning instead of failing
 * the whole install. Peers are resolved best-effort against the rest of the
 * graph; an unsatisfied peer is a warning, not an error (pnpm-lite semantics).
 */
export const materializeVirtualStore = async (options: MaterializeOptions): Promise<void> => {
  const { vfs, cwd, graph, fetchAndExtract, onWarn } = options;
  const warn = onWarn ?? (() => {});
  const materialized = new Set<string>();

  for (const [depKey, pkg] of graph.packages) {
    const targetDir = packageDirFor(cwd, pkg);
    if (vfs.hot.existsSync(targetDir)) {
      materialized.add(depKey);
      continue;
    }
    try {
      await fetchAndExtract(pkg, targetDir);
      materialized.add(depKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pkg.optional) {
        warn(`Optional dependency ${pkg.name}@${pkg.version} failed to install: ${message}; skipping.`);
      } else {
        throw error;
      }
    }
  }

  for (const [depKey, pkg] of graph.packages) {
    if (!materialized.has(depKey)) continue;
    const nodeModulesDir = `${storeDirFor(cwd, pkg)}/node_modules`;

    for (const [depName, childKey] of Object.entries(pkg.resolvedDependencies)) {
      if (!materialized.has(childKey)) {
        warn(`${pkg.name}@${pkg.version} depends on ${depName}, which failed to install; skipping link.`);
        continue;
      }
      const child = graph.packages.get(childKey)!;
      linkPackage(vfs, `${nodeModulesDir}/${depName}`, packageDirFor(cwd, child));
    }

    for (const [peerName, range] of Object.entries(pkg.peerDependencies)) {
      const peer = findSatisfyingPeer(graph.packages, peerName, range);
      if (!peer || !materialized.has(peer.depPath)) {
        warn(`${pkg.name}@${pkg.version} has an unmet peer dependency: ${peerName}@${range}.`);
        continue;
      }
      linkPackage(vfs, `${nodeModulesDir}/${peerName}`, packageDirFor(cwd, peer));
    }

    linkBins(vfs, nodeModulesDir, pkg.resolvedDependencies, graph.packages, materialized);
  }

  const rootNodeModules = `${cwd}/node_modules`;
  for (const [depName, depKey] of Object.entries(graph.rootDependencies)) {
    if (!materialized.has(depKey)) {
      warn(`Root dependency ${depName} failed to install; skipping link.`);
      continue;
    }
    const pkg = graph.packages.get(depKey)!;
    linkPackage(vfs, `${rootNodeModules}/${depName}`, packageDirFor(cwd, pkg));
  }
  linkBins(vfs, rootNodeModules, graph.rootDependencies, graph.packages, materialized);
};
