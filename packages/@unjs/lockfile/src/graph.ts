export type Format = "npm" | "yarn" | "yarn-berry" | "pnpm" | "bun-text" | "bun-binary";

export interface LocalSource {
  type: "git" | "directory" | "tarball" | "remoteTarball" | "link" | "workspace";
  url: string;
}

export interface LockedPackage {
  name: string;
  version: string;
  depPath: string;
  localSource?: LocalSource;
  integrity?: string;
  resolvedUrl?: string;
  dev: boolean;
  optional: boolean;
  peerDependencies: Record<string, string>;
  bin: Record<string, string>;
}

export interface CatalogEntry {
  default?: Record<string, string>;
  [catalogName: string]: Record<string, string> | undefined;
}

export interface Importer {
  cwd: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface LockfileMeta {
  format: Format;
  version: string;
}

export interface LockfileGraph {
  packages: Map<string, LockedPackage>;
  catalogs: Record<string, CatalogEntry>;
  importers: Importer[];
  meta: LockfileMeta;
}

export interface InstallablePackage {
  name: string;
  version: string;
  url: string;
  integrity: string;
  dev: boolean;
  optional: boolean;
  peerDependencies: Record<string, string>;
}
