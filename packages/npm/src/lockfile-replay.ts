import type { NpmLockfileV3 } from "./lockfile-writer.js";
import { pathToPackageName } from "./lockfile-writer.js";
import type { NpmPackument } from "./registry-resolver.js";

/**
 * Build synthetic packuments from a `package-lock.json` v3 so the registry
 * resolver can replay locked resolutions without network round-trips.
 *
 * Each distinct package name gets one Packument; multiple lock entries for
 * the same name (e.g. nested resolutions in diamond dependencies) are merged
 * into the `versions` map.
 */
export const syntheticPackuments = (lock: NpmLockfileV3): Map<string, NpmPackument> => {
  const map = new Map<string, NpmPackument>();

  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = pathToPackageName(path);
    const version = entry.version;
    if (!name || !version) continue;

    let packument = map.get(name);
    if (!packument) {
      packument = { name, "dist-tags": { latest: version }, versions: {} };
      map.set(name, packument);
    }

    packument.versions[version] = {
      version,
      dist: {
        tarball: entry.resolved ?? "",
        integrity: entry.integrity,
      },
      dependencies: entry.dependencies,
      peerDependencies: entry.peerDependencies,
    };
  }

  return map;
};
