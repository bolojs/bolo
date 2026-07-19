import type { ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";
import { resolvePackage, type ResolveCache, type ResolvedPackage } from "./registry-resolver.js";

const CONCURRENCY = 8;

interface QueueItem {
  name: string;
  range: string;
  optional: boolean;
  /** depPath key of the package that requested this edge, or undefined for root deps. */
  parentKey?: string;
}

/**
 * BFS dependency walk producing a full multi-version dependency graph, keyed
 * by `<name>@<version>` (the pnpm-style virtual-store key). Unlike a flat
 * resolver, every distinct version reached in the graph gets its own node —
 * two packages requiring incompatible ranges of the same dependency both get
 * installed side by side, and `resolvedDependencies` on each node records
 * exactly which sibling version satisfies which edge (real diamond-dep
 * support, see `.agents/plans/2026-07-17-virtual-store-resolver.md`).
 *
 * Optional dependencies that fail to resolve are dropped with a warning
 * instead of failing the whole install. Cycles terminate naturally: once a
 * `<name>@<version>` key is registered its own dependencies are not
 * re-queued, though it can still be linked as an edge target from many
 * parents (that's the intended sharing behavior, not a bug).
 */
export const walkDependencies = async (
  rootDeps: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  onProgress?: (message: string) => void,
  cache?: ResolveCache,
): Promise<ResolvedGraph> => {
  const packages = new Map<string, ResolvedGraphPackage>();
  const rootDependencies: Record<string, string> = {};
  const rangeResolutions = new Map<string, ResolvedPackage>();

  let queue: QueueItem[] = Object.entries(rootDeps).map(([name, range]) => ({
    name,
    range,
    optional: false,
  }));

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);

    await Promise.all(
      batch.map(async ({ name, range, optional, parentKey }) => {
        const rangeCacheKey = `${name}@${range}`;
        let resolved = rangeResolutions.get(rangeCacheKey);

        if (!resolved) {
          try {
            resolved = await resolvePackage(name, range, fetchFn, cache);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (optional) {
              onProgress?.(
                `Optional dependency ${name}@${range} failed to resolve: ${message}; skipping.`,
              );
              return;
            }
            throw error;
          }
          rangeResolutions.set(rangeCacheKey, resolved);
        }

        const key = `${resolved.name}@${resolved.version}`;

        if (parentKey) {
          const parent = packages.get(parentKey);
          if (parent) parent.resolvedDependencies[name] = key;
        } else {
          rootDependencies[name] = key;
        }

        if (packages.has(key)) return;

        const node: ResolvedGraphPackage = {
          name: resolved.name,
          version: resolved.version,
          depPath: key,
          resolvedUrl: resolved.tarballUrl,
          integrity: resolved.integrity,
          dev: false,
          optional,
          peerDependencies: resolved.peerDependencies,
          dependencies: { ...resolved.dependencies, ...resolved.optionalDependencies },
          bin: resolved.bin ?? {},
          resolvedDependencies: {},
        };
        packages.set(key, node);

        for (const [depName, depRange] of Object.entries(resolved.dependencies)) {
          queue.push({ name: depName, range: depRange, optional: false, parentKey: key });
        }
        for (const [depName, depRange] of Object.entries(resolved.optionalDependencies)) {
          queue.push({ name: depName, range: depRange, optional: true, parentKey: key });
        }
      }),
    );
  }

  return { packages, rootDependencies };
};
