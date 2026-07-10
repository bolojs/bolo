import { maxSatisfying } from "semver";

const REGISTRY = "https://registry.npmjs.org";

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

export interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  versions: Record<string, NpmVersion>;
}

interface NpmVersion {
  version: string;
  dist: { tarball: string; integrity?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Optional packument cache — avoids repeated registry round-trips. */
export interface ResolveCache {
  get?: (name: string) => Promise<NpmPackument | null>;
  set?: (name: string, packument: NpmPackument) => Promise<void>;
}

/**
 * Resolve a package name + semver range to a concrete tarball URL via the
 * npm registry. Handles `npm:` alias syntax (`npm:other-pkg@1.2.3`).
 * An optional cache avoids repeated registry round-trips for the same packument.
 */
export const resolvePackage = async (
  name: string,
  range: string,
  fetchFn: typeof fetch = fetch,
  cache?: ResolveCache,
): Promise<ResolvedPackage> => {
  if (range.startsWith("npm:")) {
    const spec = range.slice(4);
    const atIdx = spec.lastIndexOf("@");
    const aliasName = atIdx > 0 ? spec.slice(0, atIdx) : spec;
    const aliasVersion = atIdx > 0 ? spec.slice(atIdx + 1) : "*";
    const resolved = await resolvePackage(aliasName, aliasVersion, fetchFn, cache);
    return { ...resolved, name };
  }

  let packument = cache?.get ? await cache.get(name) : null;

  if (!packument) {
    const res = await fetchFn(`${REGISTRY}/${name}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) {
      throw new Error(`Registry fetch failed for ${name}: ${res.status}`);
    }
    packument = (await res.json()) as NpmPackument;
    if (cache?.set) await cache.set(name, packument);
  }

  const versions = Object.keys(packument.versions);
  const matched =
    range === "*" || range === ""
      ? (packument["dist-tags"]?.latest ?? versions[versions.length - 1])
      : maxSatisfying(versions, range);

  if (!matched) {
    throw new Error(`No version of ${name} satisfies ${range}`);
  }

  const entry = packument.versions[matched]!;
  return {
    name,
    version: matched,
    tarballUrl: entry.dist.tarball,
    integrity: entry.dist.integrity ?? "",
    dependencies: entry.dependencies ?? {},
    peerDependencies: entry.peerDependencies ?? {},
    optionalDependencies: entry.optionalDependencies ?? {},
  };
};
