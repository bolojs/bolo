import { parseSyml } from "@yarnpkg/parsers";
import type { Importer, LockfileGraph, LockedPackage, LockfileMeta } from "../graph.js";

interface BerryEntry {
  version?: string;
  resolution: string;
  checksum?: string;
  languageName?: string;
  linkType?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

interface BerryLock {
  __metadata: {
    version: string;
    cacheKey: string;
  };
  [key: string]: unknown;
}

export function parseYarnBerry(content: string): LockfileGraph {
  const lock = parseSyml(content) as BerryLock;
  const metadata = lock.__metadata ?? { version: "8", cacheKey: "8" };
  const packages = new Map<string, LockedPackage>();

  for (const [key, raw] of Object.entries(lock)) {
    if (key === "__metadata") continue;
    const entry = raw as BerryEntry;
    const resolution = entry.resolution;
    const { name, version } = parseResolution(resolution);
    const depPath = resolution;

    const locked: LockedPackage = {
      name,
      version: entry.version ?? version,
      depPath,
      integrity: entry.checksum,
      resolvedUrl: buildTarballUrl(name, entry.version ?? version),
      dev: false,
      optional: false,
      peerDependencies: entry.peerDependencies ?? {},
      bin: entry.bin ?? {},
    };
    packages.set(depPath, locked);
  }

  const meta: LockfileMeta = { format: "yarn-berry", version: metadata.version };
  const importers: Importer[] = [
    {
      cwd: ".",
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
    },
  ];

  return { packages, catalogs: {}, importers, meta };
}

function parseResolution(resolution: string): { name: string; version: string } {
  const separator = resolution.indexOf("@", 1);
  if (separator === -1) {
    return { name: resolution, version: "" };
  }
  const name = resolution.slice(0, separator);
  const locator = resolution.slice(separator + 1);
  const versionMatch = /^(?:[^:]+:)?([^#]+)/.exec(locator);
  const version = versionMatch?.[1] ?? locator;
  return { name, version };
}

function buildTarballUrl(name: string, version: string): string | undefined {
  if (!version || version.startsWith("workspace:") || version.startsWith("patch:")) {
    return undefined;
  }
  const encodedName = encodeURIComponent(name).replace(/%40/g, "@");
  return `https://registry.npmjs.org/${encodedName}/-/${name.split("/").pop()}-${version}.tgz`;
}
