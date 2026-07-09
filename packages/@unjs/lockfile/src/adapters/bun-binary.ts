import * as bunLockb from "@hyrious/bun.lockb";
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

export function parseBunBinary(content: ArrayBuffer | Uint8Array): LockfileGraph {
  const buffer =
    content instanceof Uint8Array
      ? (content.buffer.slice(
          content.byteOffset,
          content.byteOffset + content.byteLength,
        ) as ArrayBuffer)
      : content;
  const yarnText = bunLockb.parse(buffer);
  const parsed = yarnLockfile.parse(yarnText);
  if (parsed.type !== "success") {
    throw new Error("Failed to parse bun.lockb via yarn text fallback");
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

  const meta: LockfileMeta = { format: "bun-binary", version: "0" };
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
