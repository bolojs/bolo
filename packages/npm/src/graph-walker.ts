import { satisfies } from "semver";
import type { InstallablePackage } from "@unjs/lockfile";
import { resolvePackage, type ResolveCache, type ResolvedPackage } from "./registry-resolver.js";

const CONCURRENCY = 8;

interface QueueItem {
  name: string;
  range: string;
}

/**
 * BFS dependency walk producing a flat `node_modules` install list.
 * First version of each package wins; later incompatible versions are
 * skipped with a warning (same model as Nodepod / almostnode).
 *
 * Cycle detection is implicit: once a package name enters `seen` it is
 * never re-queued, so `A → B → A` terminates naturally.
 *
 * All requested ranges are tracked and checked in a final pass so that
 * conflicts from parallel batches are not silently lost.
 *
 * Known limitation: no peer-dep resolution, no optional-dep failure
 * tolerance, no nested dedup. Documented in the migration plan.
 */
export const walkDependencies = async (
  rootDeps: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  onProgress?: (message: string) => void,
  cache?: ResolveCache,
): Promise<InstallablePackage[]> => {
  const result: InstallablePackage[] = [];
  const installed = new Map<string, ResolvedPackage>();
  const seen = new Set<string>();
  const requestedRanges = new Map<string, string[]>();

  const trackRange = (name: string, range: string) => {
    if (!requestedRanges.has(name)) requestedRanges.set(name, []);
    requestedRanges.get(name)!.push(range);
  };

  let queue: QueueItem[] = [];
  for (const [name, range] of Object.entries(rootDeps)) {
    trackRange(name, range);
    if (!seen.has(name)) {
      seen.add(name);
      queue.push({ name, range });
    }
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);

    await Promise.all(
      batch.map(async ({ name, range }) => {
        const existing = installed.get(name);
        if (existing) {
          // Conflict (if any) is reported in the final pass
          return;
        }

        const pkg = await resolvePackage(name, range, fetchFn, cache);

        if (installed.has(name)) {
          // Another batch item installed while we fetched — final pass reports
          return;
        }

        installed.set(name, pkg);
        result.push({
          name: pkg.name,
          version: pkg.version,
          url: pkg.tarballUrl,
          integrity: pkg.integrity,
          dev: false,
          optional: false,
          peerDependencies: pkg.peerDependencies,
        });

        for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
          trackRange(depName, depRange);
          if (!seen.has(depName)) {
            seen.add(depName);
            queue.push({ name: depName, range: depRange });
          }
        }
      }),
    );
  }

  // Final pass: warn about ranges the installed version doesn't satisfy
  for (const [name, ranges] of requestedRanges) {
    const pkg = installed.get(name);
    if (!pkg) continue;
    for (const range of ranges) {
      if (!satisfies(pkg.version, range)) {
        onProgress?.(
          `Version conflict for ${name}: installed ${pkg.version}, but ${range} was also requested.`,
        );
      }
    }
  }

  return result;
};
