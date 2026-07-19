import type { ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";

export interface NpmLockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
  peerDependencies?: Record<string, string>;
}

export interface NpmLockfileV3 {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, NpmLockEntry>;
}

const entryFor = (pkg: ResolvedGraphPackage): NpmLockEntry => ({
  version: pkg.version,
  resolved: pkg.resolvedUrl || undefined,
  integrity: pkg.integrity || undefined,
  dependencies: Object.keys(pkg.dependencies).length > 0 ? pkg.dependencies : undefined,
  dev: pkg.dev || undefined,
  optional: pkg.optional || undefined,
  peerDependencies: Object.keys(pkg.peerDependencies).length > 0 ? pkg.peerDependencies : undefined,
});

const buildPackagesFromGraph = (
  graph: ResolvedGraph,
  rootDeps: Record<string, string>,
  rootVersion: string,
): Record<string, NpmLockEntry> => {
  const packages: Record<string, NpmLockEntry> = {
    "": { version: rootVersion, dependencies: rootDeps },
  };
  const occupant = new Map<string, string>();

  const place = (path: string, depKey: string, pkg: ResolvedGraphPackage): void => {
    occupant.set(path, depKey);
    packages[path] = entryFor(pkg);
  };

  const expand = (depKey: string, parentPath: string, ancestors: Set<string>): void => {
    const pkg = graph.packages.get(depKey);
    if (!pkg) return;
    const nextAncestors = new Set(ancestors).add(depKey);

    for (const [depName, childKey] of Object.entries(pkg.resolvedDependencies)) {
      const rootPath = `node_modules/${depName}`;
      const existing = occupant.get(rootPath);

      if (existing === childKey) continue;

      if (existing === undefined) {
        const child = graph.packages.get(childKey);
        if (!child) continue;
        place(rootPath, childKey, child);
        if (!ancestors.has(childKey)) expand(childKey, rootPath, nextAncestors);
        continue;
      }

      const nestedPath = `${parentPath}/node_modules/${depName}`;
      if (occupant.get(nestedPath) === childKey) continue;
      const child = graph.packages.get(childKey);
      if (!child) continue;
      place(nestedPath, childKey, child);
      if (!ancestors.has(childKey)) expand(childKey, nestedPath, nextAncestors);
    }
  };

  for (const [name, depKey] of Object.entries(graph.rootDependencies)) {
    const pkg = graph.packages.get(depKey);
    if (!pkg) continue;
    const rootPath = `node_modules/${name}`;
    place(rootPath, depKey, pkg);
  }
  for (const [name, depKey] of Object.entries(graph.rootDependencies)) {
    if (!graph.packages.has(depKey)) continue;
    expand(depKey, `node_modules/${name}`, new Set([depKey]));
  }

  return packages;
};

export const pathToPackageName = (path: string): string | null => {
  if (path === "") return null;
  const parts = path.split("/");
  // Scoped packages are represented as two final segments: @scope/pkg
  if (parts.length >= 2 && parts[parts.length - 2].startsWith("@")) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1];
};

const computeReachablePaths = (
  packages: Record<string, NpmLockEntry>,
  rootNames: string[],
  graph: ResolvedGraph,
): Set<string> => {
  const nameToPaths = new Map<string, string[]>();
  for (const path of Object.keys(packages)) {
    const name = pathToPackageName(path);
    if (!name) continue;
    const paths = nameToPaths.get(name) ?? [];
    paths.push(path);
    nameToPaths.set(name, paths);
  }

  const graphDepsByName = new Map<string, string[]>();
  for (const pkg of graph.packages.values()) {
    graphDepsByName.set(pkg.name, Object.keys(pkg.resolvedDependencies));
  }

  const reachable = new Set<string>();
  const queue = [...rootNames];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    const paths = nameToPaths.get(name);
    if (!paths) continue;
    for (const path of paths) {
      if (reachable.has(path)) continue;
      reachable.add(path);
      const entry = packages[path];
      const depNames = new Set<string>([
        ...(graphDepsByName.get(name) ?? []),
        ...(entry.dependencies ? Object.keys(entry.dependencies) : []),
      ]);
      for (const depName of depNames) {
        if (!queue.includes(depName)) queue.push(depName);
      }
    }
  }
  return reachable;
};

export const mergeLockfiles = (
  previous: Record<string, NpmLockEntry> | undefined,
  current: Record<string, NpmLockEntry>,
  rootDeps: Record<string, string>,
  rootNames: string[],
  graph: ResolvedGraph,
): Record<string, NpmLockEntry> => {
  const merged: Record<string, NpmLockEntry> = { ...previous };
  for (const [path, entry] of Object.entries(current)) {
    merged[path] = entry;
  }
  merged[""] = { ...merged[""], dependencies: rootDeps };

  const reachable = computeReachablePaths(merged, rootNames, graph);
  const pruned: Record<string, NpmLockEntry> = {};
  for (const path of reachable) {
    pruned[path] = merged[path];
  }
  // ponytail: always keep the root entry even if it has no deps
  pruned[""] = merged[""];
  return pruned;
};

/**
 * Serialize a resolved dependency graph to `package-lock.json` v3 format.
 * Root dependencies always land flat at `node_modules/<name>`; a transitive
 * dependency is hoisted to that same flat slot when it doesn't conflict with
 * what's already there, and nested under its requiring parent
 * (`node_modules/<parent>/node_modules/<name>`) otherwise — the standard npm
 * v3 shape for representing diamond dependencies that resolve to different
 * versions (see `.agents/plans/2026-07-17-virtual-store-resolver.md`).
 */
export const serializeNpmLockfile = (
  graph: ResolvedGraph,
  rootDeps: Record<string, string>,
  rootName = "app",
  rootVersion = "1.0.0",
  previous?: NpmLockfileV3,
): string => {
  const currentPackages = buildPackagesFromGraph(graph, rootDeps, rootVersion);
  const rootNames = [
    ...new Set([...Object.keys(rootDeps), ...Object.keys(graph.rootDependencies)]),
  ];
  const packages = mergeLockfiles(previous?.packages, currentPackages, rootDeps, rootNames, graph);
  const lockfile: NpmLockfileV3 = {
    name: rootName,
    version: rootVersion,
    lockfileVersion: 3,
    packages,
  };

  return JSON.stringify(lockfile, null, 2);
};
