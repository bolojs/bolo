import { maxSatisfying, satisfies } from "semver";
import type { InstallablePackage, LockfileGraph, LockedPackage } from "./graph.js";

/** A `LockedPackage` whose declared `dependencies` have been resolved to concrete graph entries. */
export interface ResolvedGraphPackage extends LockedPackage {
  /** depName -> depPath key into `ResolvedGraph.packages` that satisfies this edge. */
  resolvedDependencies: Record<string, string>;
}

export interface ResolvedGraph {
  /** All packages needed by `cwd`'s importer, keyed by their lockfile `depPath`. */
  packages: Map<string, ResolvedGraphPackage>;
  /** Top-level dep name -> depPath key, for the importer at `cwd`. */
  rootDependencies: Record<string, string>;
}

/**
 * Resolve a lockfile graph into a form a virtual-store materializer can walk
 * directly: every package's declared dependencies are pinned to a concrete
 * depPath, using nested `node_modules/` placement where the lockfile encodes
 * it (npm v3) and falling back to name+semver matching otherwise (pnpm/yarn/
 * bun, and npm's own root-level deps). Unlike `resolve()`, multiple versions
 * of the same package are preserved rather than collapsed to one.
 */
export function resolveGraph(graph: LockfileGraph, cwd = "."): ResolvedGraph {
  const importer = graph.importers.find((i) => i.cwd === cwd) ?? graph.importers[0];
  const rootDeps: Record<string, string> = importer
    ? {
        ...importer.dependencies,
        ...importer.devDependencies,
        ...importer.optionalDependencies,
      }
    : {};

  const byName = new Map<string, LockedPackage[]>();
  for (const pkg of graph.packages.values()) {
    if (!byName.has(pkg.name)) byName.set(pkg.name, []);
    byName.get(pkg.name)!.push(pkg);
  }

  const findByName = (depName: string, range: string): LockedPackage | undefined => {
    const candidates = byName.get(depName);
    if (!candidates || candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    const versions = candidates.map((c) => c.version).filter(Boolean);
    const best = maxSatisfying(versions, range);
    if (best) return candidates.find((c) => c.version === best);
    return candidates.find((c) => satisfies(c.version, range, { loose: true })) ?? candidates[0];
  };

  /** Node-style nearest-`node_modules`-wins search, for lockfiles that nest depPaths. */
  const resolveDepPath = (
    fromDepPath: string,
    depName: string,
    range: string,
  ): string | undefined => {
    const chain =
      fromDepPath === "." || fromDepPath === ""
        ? []
        : fromDepPath.replace(/^node_modules\//, "").split("/node_modules/");

    for (let depth = chain.length; depth >= 0; depth--) {
      const prefix = chain.slice(0, depth).join("/node_modules/");
      const candidateKey = prefix
        ? `node_modules/${prefix}/node_modules/${depName}`
        : `node_modules/${depName}`;
      const candidate = graph.packages.get(candidateKey);
      if (candidate) return candidateKey;
    }

    const byNameMatch = findByName(depName, range);
    return byNameMatch?.depPath;
  };

  const packages = new Map<string, ResolvedGraphPackage>();
  for (const [depPath, pkg] of graph.packages) {
    // `.` (and `""`) is the importer's own package record, not an installable dependency.
    if (depPath === "." || depPath === "") continue;
    const resolvedDependencies: Record<string, string> = {};
    for (const [depName, range] of Object.entries(pkg.dependencies)) {
      const resolved = resolveDepPath(depPath, depName, range);
      if (resolved) resolvedDependencies[depName] = resolved;
    }
    packages.set(depPath, { ...pkg, resolvedDependencies });
  }

  const rootDependencies: Record<string, string> = {};
  for (const [depName, range] of Object.entries(rootDeps)) {
    const resolved = resolveDepPath(".", depName, range);
    if (resolved) rootDependencies[depName] = resolved;
  }

  return { packages, rootDependencies };
}

export function resolve(graph: LockfileGraph, cwd = "."): InstallablePackage[] {
  const importer = graph.importers.find((i) => i.cwd === cwd) ?? graph.importers[0];
  if (!importer) {
    return [];
  }

  const directDeps = new Map<string, string>();
  for (const [name, spec] of Object.entries({
    ...importer.dependencies,
    ...importer.devDependencies,
    ...importer.optionalDependencies,
  })) {
    directDeps.set(name, spec);
  }

  const result: InstallablePackage[] = [];
  const seen = new Set<string>();

  for (const pkg of Array.from(graph.packages.values())) {
    if (!pkg.name || !pkg.version) continue;
    if (!pkg.resolvedUrl) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isDev = isDevPackage(pkg, directDeps);
    const isOptional = pkg.optional;

    result.push({
      name: pkg.name,
      version: pkg.version,
      url: pkg.resolvedUrl,
      integrity: pkg.integrity ?? "",
      dev: isDev,
      optional: isOptional,
      peerDependencies: pkg.peerDependencies,
    });
  }

  return result;
}

function isDevPackage(pkg: LockedPackage, directDeps: Map<string, string>): boolean {
  return pkg.dev || directDeps.has(pkg.name);
}
