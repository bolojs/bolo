import * as yarnLockfile from "@yarnpkg/lockfile";
import type { Importer, LockfileGraph, LockedPackage, LockfileMeta } from "../graph.js";

interface YarnEntry {
  version: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

export function parseYarn(content: string): LockfileGraph {
  const parsed = yarnLockfile.parse(content);
  if (parsed.type !== "success") {
    throw new Error("Failed to parse yarn.lock v1");
  }

  const packages = new Map<string, LockedPackage>();
  const entries: Record<string, YarnEntry> = parsed.object;

  for (const [key, entry] of Object.entries(entries)) {
    const primaryKey =
      key
        .split(",")
        .map((k) => k.trim())
        .sort()[0] ?? key;
    const { name, version } = parseDescriptor(primaryKey);
    const depPath = `${name}@${version}`;

    const locked: LockedPackage = {
      name,
      version: entry.version,
      depPath,
      integrity: entry.integrity,
      resolvedUrl: entry.resolved,
      dev: false,
      optional: false,
      peerDependencies: entry.peerDependencies ?? {},
      bin: entry.bin ?? {},
    };
    packages.set(depPath, locked);
  }

  const meta: LockfileMeta = { format: "yarn", version: "1" };
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

function parseDescriptor(descriptor: string): { name: string; version: string } {
  const separator = descriptor.indexOf("@", 1);
  if (separator === -1) {
    return { name: descriptor, version: "" };
  }
  return {
    name: descriptor.slice(0, separator),
    version: descriptor.slice(separator + 1),
  };
}
