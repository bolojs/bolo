import type { Importer, LockfileGraph, LockedPackage, LockfileMeta } from "../graph.js";

interface NpmPackage {
  name?: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NpmLock {
  lockfileVersion: number | string;
  packages?: Record<string, NpmPackage>;
  dependencies?: Record<string, NpmPackage & { requires?: Record<string, string> }>;
}

export function parseNpm(content: string): LockfileGraph {
  const lock: NpmLock = JSON.parse(content);
  const version = String(lock.lockfileVersion ?? "3");
  const packages = new Map<string, LockedPackage>();
  const importers: Importer[] = [];

  if (lock.packages) {
    for (const [pathKey, pkg] of Object.entries(lock.packages)) {
      const depPath = pathKey || ".";
      const name = pkg.name ?? extractNameFromPath(depPath);
      const locked: LockedPackage = {
        name,
        version: pkg.version,
        depPath,
        integrity: pkg.integrity,
        resolvedUrl: pkg.resolved,
        dev: pkg.dev ?? false,
        optional: pkg.optional ?? false,
        peerDependencies: pkg.peerDependencies ?? {},
        dependencies: pkg.dependencies ?? {},
        bin: pkg.bin ?? {},
      };
      packages.set(depPath, locked);

      if (depPath === ".") {
        importers.push({
          cwd: ".",
          dependencies: pkg.dependencies ?? {},
          devDependencies: pkg.devDependencies ?? {},
          optionalDependencies: pkg.optionalDependencies ?? {},
          peerDependencies: pkg.peerDependencies ?? {},
        });
      }
    }
  }

  if (lock.dependencies && !lock.packages) {
    for (const [name, pkg] of Object.entries(lock.dependencies)) {
      const depPath = `node_modules/${name}`;
      const locked: LockedPackage = {
        name,
        version: pkg.version,
        depPath,
        integrity: pkg.integrity,
        resolvedUrl: pkg.resolved,
        dev: pkg.dev ?? false,
        optional: pkg.optional ?? false,
        peerDependencies: {},
        dependencies: pkg.requires ?? {},
        bin: pkg.bin ?? {},
      };
      packages.set(depPath, locked);
    }

    importers.push({
      cwd: ".",
      dependencies: Object.fromEntries(
        Object.entries(lock.dependencies).map(([name, pkg]) => [name, pkg.version]),
      ),
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    });
  }

  if (importers.length === 0) {
    importers.push({
      cwd: ".",
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    });
  }

  const meta: LockfileMeta = { format: "npm", version };
  return { packages, catalogs: {}, importers, meta };
}

function extractNameFromPath(pathKey: string): string {
  const parts = pathKey.split("node_modules/");
  return parts[parts.length - 1] ?? "";
}
