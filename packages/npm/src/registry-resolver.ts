import { maxSatisfying } from "semver";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  bin: Record<string, string>;
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
  bin?: Record<string, string> | string;
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
  options: { registryBase?: string; fetchFn?: typeof fetch } = {},
  cache?: ResolveCache,
): Promise<ResolvedPackage> => {
  const envRegistry = globalThis.process?.env?.npm_config_registry;
  const registry = (options.registryBase ?? envRegistry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  if (range.startsWith("npm:")) {
    const spec = range.slice(4);
    const atIdx = spec.lastIndexOf("@");
    const aliasName = atIdx > 0 ? spec.slice(0, atIdx) : spec;
    const aliasVersion = atIdx > 0 ? spec.slice(atIdx + 1) : "*";
    const resolved = await resolvePackage(aliasName, aliasVersion, options, cache);
    return { ...resolved, name };
  }

  const key = `${registry}/${name}`;
  let packument = cache?.get ? await cache.get(key) : null;

  if (!packument) {
    const res = await fetchFn(`${registry}/${name}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) {
      throw new Error(`Registry fetch failed for ${name}: ${res.status}`);
    }
    packument = (await res.json()) as NpmPackument;
    if (cache?.set) await cache.set(key, packument);
  }

  const versions = Object.keys(packument.versions);
  const distTag = packument["dist-tags"]?.[range];
  const matched =
    range === "*" || range === ""
      ? (packument["dist-tags"]?.latest ?? versions[versions.length - 1])
      : distTag !== undefined
        ? distTag
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
    bin: normalizeBin(name, entry.bin),
  };
};

/** npm allows `bin` as a bare string (shorthand for `{ [name]: bin }`) or an object map. */
const normalizeBin = (
  name: string,
  bin?: Record<string, string> | string,
): Record<string, string> => {
  if (!bin) return {};
  if (typeof bin === "string") return { [name.split("/").pop()!]: bin };
  return bin;
};
