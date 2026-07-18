import type { Importer, LockfileGraph, LockedPackage, LockfileMeta } from "../graph.js";

interface BunPackageTuple extends Array<unknown> {
  0: string;
  1?: string;
  2?: Record<string, string>;
  3?: string;
}

interface BunLock {
  lockfileVersion: number;
  workspaces?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
  packages: Record<string, BunPackageTuple>;
}

export function parseBunText(content: string): LockfileGraph {
  const stripped = stripJsonc(content);
  const lock: BunLock = JSON.parse(stripped);
  const packages = new Map<string, LockedPackage>();
  const importers: Importer[] = [];

  for (const [pkgKey, tuple] of Object.entries(lock.packages)) {
    const versionKey = tuple[0];
    const resolvedUrl = typeof tuple[1] === "string" ? tuple[1] : undefined;
    const deps = tuple[2] as Record<string, string> | undefined;
    const integrity = tuple[3] as string | undefined;
    const { name, version } = parseVersionKey(versionKey ?? pkgKey);
    const depPath = `${name}@${version}`;

    const locked: LockedPackage = {
      name,
      version,
      depPath,
      integrity,
      resolvedUrl: resolvedUrl || buildTarballUrl(name, version),
      dev: false,
      optional: false,
      peerDependencies: {},
      dependencies: deps ?? {},
      bin: {},
    };
    packages.set(depPath, locked);
  }

  if (lock.workspaces) {
    for (const [cwd, workspace] of Object.entries(lock.workspaces)) {
      importers.push({
        cwd,
        dependencies: workspace.dependencies ?? {},
        devDependencies: workspace.devDependencies ?? {},
        optionalDependencies: workspace.optionalDependencies ?? {},
        peerDependencies: workspace.peerDependencies ?? {},
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

  const meta: LockfileMeta = { format: "bun-text", version: String(lock.lockfileVersion ?? 0) };
  return { packages, catalogs: {}, importers, meta };
}

function stripJsonc(content: string): string {
  return content.replace(/,(\s*[}\]])/g, "$1").replace(/\/\/[^\n]*/g, "");
}

function parseVersionKey(key: string): { name: string; version: string } {
  const separator = key.indexOf("@", 1);
  if (separator === -1) {
    return { name: key, version: "" };
  }
  return {
    name: key.slice(0, separator),
    version: key.slice(separator + 1),
  };
}

function buildTarballUrl(name: string, version: string): string | undefined {
  if (!version) return undefined;
  const encodedName = encodeURIComponent(name).replace(/%40/g, "@");
  return `https://registry.npmjs.org/${encodedName}/-/${name.split("/").pop()}-${version}.tgz`;
}
