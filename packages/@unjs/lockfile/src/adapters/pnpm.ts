import { load } from "js-yaml";
import type {
  CatalogEntry,
  Importer,
  LockfileGraph,
  LockedPackage,
  LockfileMeta,
} from "../graph.js";

interface PnpmLock {
  lockfileVersion: string | number;
  importers?: Record<
    string,
    {
      dependencies?: Record<string, { specifier: string; version: string }>;
      devDependencies?: Record<string, { specifier: string; version: string }>;
      optionalDependencies?: Record<string, { specifier: string; version: string }>;
      peerDependencies?: Record<string, string>;
    }
  >;
  packages?: Record<string, PnpmPackage>;
  snapshots?: Record<string, PnpmSnapshot>;
  catalogs?: Record<string, CatalogEntry>;
  settings?: Record<string, unknown>;
}

interface PnpmPackage {
  resolution?: { integrity?: string; tarball?: string; commit?: string; repo?: string };
  dev?: boolean;
  optional?: boolean;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

interface PnpmSnapshot {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  transitivePeerDependencies?: string[];
}

export function parsePnpm(content: string): LockfileGraph {
  const lock = load(content) as PnpmLock;
  const version = String(lock.lockfileVersion ?? "9.0");
  const packages = new Map<string, LockedPackage>();
  const importers: Importer[] = [];

  if (lock.packages) {
    for (const [depPath, pkg] of Object.entries(lock.packages)) {
      const { name, version: pkgVersion } = parseDepPath(depPath);
      const res = pkg.resolution ?? {};
      const locked: LockedPackage = {
        name,
        version: pkgVersion,
        depPath,
        integrity: res.integrity,
        resolvedUrl: res.tarball ?? buildTarballUrl(name, pkgVersion),
        dev: pkg.dev ?? false,
        optional: pkg.optional ?? false,
        peerDependencies: pkg.peerDependencies ?? {},
        bin: pkg.bin ?? {},
      };
      packages.set(depPath, locked);
    }
  }

  if (lock.importers) {
    for (const [cwd, importer] of Object.entries(lock.importers)) {
      importers.push({
        cwd,
        dependencies: mapVersions(importer.dependencies),
        devDependencies: mapVersions(importer.devDependencies),
        optionalDependencies: mapVersions(importer.optionalDependencies),
        peerDependencies: importer.peerDependencies ?? {},
      });
    }
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

  const meta: LockfileMeta = { format: "pnpm", version };
  return { packages, catalogs: lock.catalogs ?? {}, importers, meta };
}

function parseDepPath(depPath: string): { name: string; version: string } {
  const normalized = depPath.startsWith("/") ? depPath.slice(1) : depPath;
  const parenIndex = normalized.indexOf("(");
  const core = parenIndex === -1 ? normalized : normalized.slice(0, parenIndex);
  const separator = core.indexOf("@", 1);
  if (separator === -1) {
    return { name: core, version: "" };
  }
  return {
    name: core.slice(0, separator),
    version: core.slice(separator + 1),
  };
}

function buildTarballUrl(name: string, version: string): string | undefined {
  if (!version) return undefined;
  const encodedName = encodeURIComponent(name).replace(/%40/g, "@");
  return `https://registry.npmjs.org/${encodedName}/-/${name.split("/").pop()}-${version}.tgz`;
}

function mapVersions(
  deps?: Record<string, { specifier: string; version: string }>,
): Record<string, string> {
  if (!deps) return {};
  return Object.fromEntries(Object.entries(deps).map(([name, spec]) => [name, spec.version]));
}
