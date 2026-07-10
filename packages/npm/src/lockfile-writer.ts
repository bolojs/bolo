import type { InstallablePackage } from "@unjs/lockfile";

interface NpmLockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  dev?: boolean;
  optional?: boolean;
  peerDependencies?: Record<string, string>;
}

interface NpmLockfileV3 {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, NpmLockEntry>;
}

/**
 * Serialize resolved installables to `package-lock.json` v3 format —
 * the most universally compatible lockfile format.
 */
export const serializeNpmLockfile = (
  installables: InstallablePackage[],
  rootDeps: Record<string, string>,
  rootName = "app",
  rootVersion = "1.0.0",
): string => {
  const packages: Record<string, NpmLockEntry> = {
    "": { version: rootVersion, dependencies: rootDeps },
  };

  for (const pkg of installables) {
    packages[`node_modules/${pkg.name}`] = {
      version: pkg.version,
      resolved: pkg.url,
      integrity: pkg.integrity || undefined,
      dev: pkg.dev || undefined,
      optional: pkg.optional || undefined,
      peerDependencies:
        Object.keys(pkg.peerDependencies).length > 0 ? pkg.peerDependencies : undefined,
    };
  }

  const lockfile: NpmLockfileV3 = {
    name: rootName,
    version: rootVersion,
    lockfileVersion: 3,
    packages,
  };

  return JSON.stringify(lockfile, null, 2);
};
