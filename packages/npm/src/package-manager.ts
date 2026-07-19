import type { VfsBus } from "@bolojs/vfs-bus";
import { getLogger } from "@bolojs/log/browser";
import { createFsFromVolume } from "memfs";
import { parse, resolveGraph } from "@unjs/lockfile";
import type { LockfileGraph, ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";
import { buildEsmShUrl } from "./esm-sh.js";
import { walkDependencies } from "./graph-walker.js";
import { serializeNpmLockfile } from "./lockfile-writer.js";
import type { NpmPackument, ResolveCache } from "./registry-resolver.js";
import { materializeVirtualStore } from "./virtual-store.js";

const logger = getLogger(["bolo", "npm", "package-manager"]);

export interface ImportMap {
  imports: Record<string, string>;
}

export type InstallStrategyFn = (ctx: InstallContext) => Promise<void>;

export type InstallStrategy = "lockfile-only" | "browser-native" | InstallStrategyFn;

export interface InstallContext {
  lockfileGraph: LockfileGraph;
  vfs: VfsBus;
  cwd: string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface PackageManagerOptions {
  vfs: VfsBus;
  cwd?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  installStrategy?: InstallStrategy;
  registryBase?: string;
}

const DEFAULT_CWD = "/home/web/app";

// ponytail: 7-day TTL is generous; packuments rarely change and the registry
// is the source of truth for dist-tags. Reduce if stale-version bugs appear.
const PACKUMENT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Packages that import `react` internally must be externalized (esm.sh `*` prefix)
// so the browser re-resolves their `react` import through this importmap's single
// pinned entry instead of esm.sh bundling its own copy — otherwise invalid-hook-call.
const REACT_DEPENDENT_PACKAGES = new Set(["react-dom"]);

// esm.sh's `*` external prefix leaves ALL of the package's own bare imports
// unresolved, not just `react` — react-dom's build also imports `scheduler`
// verbatim. These peers need their own (non-externalized) importmap entry.
const EXTERNALIZED_PEER_DEPS: Record<string, string[]> = {
  "react-dom": ["scheduler"],
};

// Build-only tooling that must be installed but has no browser-runtime import.
const BUILD_TOOLING_PACKAGES = new Set(["vite", "typescript", "esbuild"]);

const LOCKFILE_CANDIDATES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/**
 * Browser-side package manager. Supports two install strategies:
 * - `browser-native` (default): resolves from the npm registry, walks the
 *   dependency graph, fetches tarballs, and extracts them into `node_modules/`.
 *   Uses a lockfile if present for deterministic installs.
 * - `lockfile-only`: parses a lockfile with `@unjs/lockfile`, fetches tarballs
 *   via `fetch`, and extracts them into `node_modules/`.
 * A custom function can also be provided as the strategy.
 */
export class PackageManager {
  private vfs: VfsBus;
  private cwd: string;
  private stdout?: (chunk: string) => void;
  private stderr?: (chunk: string) => void;
  private fs: ReturnType<typeof createFsFromVolume>;
  private installStrategy: InstallStrategy;
  private lastImportMapSpecifiers: string[] | null = null;
  // ponytail: sidecar exec-bit map; lift into VfsBus metadata when more than two consumers need it
  private readonly execBits = new Map<string, number>();
  private registryBase?: string;

  constructor(options: PackageManagerOptions) {
    this.vfs = options.vfs;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.fs = createFsFromVolume(this.vfs["vol"]) as ReturnType<typeof createFsFromVolume>;
    this.installStrategy = options.installStrategy ?? "browser-native";
    this.registryBase = options.registryBase;
  }

  /**
   * Install packages. If no packages are specified, reads from package.json.
   * The `browser-native` strategy uses a lockfile if present, otherwise
   * resolves from the registry.
   */
  async install(packages?: string[]): Promise<void> {
    this.execBits.clear();
    const strategy = this.installStrategy;

    if (typeof strategy === "function") {
      await strategy(this.buildInstallContext());
    } else if (strategy === "lockfile-only") {
      await this.installLockfileOnly();
    } else {
      await this.installBrowserNative(packages);
    }

    await this.writeImportMap();
  }

  /**
   * Return the executable-bit mask (mode & 0o111) recorded for a file during
   * tarball extraction. Returns 0 when no exec bit was recorded.
   */
  getExecBit(path: string): number {
    return this.execBits.get(path) ?? 0;
  }

  /**
   * Generate import map with esm.sh CDN fallback URLs.
   * Emits both an exact entry and a trailing-slash prefix entry per package so
   * subpath imports (e.g. `react-dom/client`, `react/jsx-runtime`) resolve too.
   */
  generateImportMap(packages: string[]): ImportMap {
    const imports: Record<string, string> = {};

    for (const pkg of packages) {
      const [name, version] = this.parsePackageSpecifier(pkg);
      const external = REACT_DEPENDENT_PACKAGES.has(name);
      imports[name] = buildEsmShUrl(name, version, external);
      imports[`${name}/`] = buildEsmShUrl(name, version, external, true);

      for (const peer of EXTERNALIZED_PEER_DEPS[name] ?? []) {
        if (imports[peer]) continue;
        const peerVersion = this.readInstalledVersion(peer);
        imports[peer] = buildEsmShUrl(peer, peerVersion);
      }
    }

    return { imports };
  }

  private async installLockfileOnly(): Promise<void> {
    const lockfile = this.detectLockfile();
    if (!lockfile) {
      this.warn("No lockfile found; falling back to browser-native");
      await this.installBrowserNative();
      return;
    }

    try {
      const lockfileGraph = parse(lockfile.content);
      const graph = resolveGraph(lockfileGraph, this.cwd);
      await materializeVirtualStore({
        vfs: this.vfs,
        cwd: this.cwd,
        graph,
        fetchAndExtract: (pkg, targetDir) => this.fetchAndExtract(pkg, targetDir),
        onWarn: (msg) => this.warn(msg),
        execBits: this.execBits,
      });
    } catch (error) {
      this.warn(
        `lockfile-only install failed: ${error instanceof Error ? error.message : String(error)}; falling back to browser-native`,
      );
      await this.installBrowserNative();
    }
  }

  /**
   * Browser-native install: use lockfile if present (deterministic), otherwise
   * resolve from the npm registry. Always writes a package-lock.json after
   * install so subsequent installs are deterministic.
   */
  private async installBrowserNative(packages?: string[]): Promise<void> {
    let graph: ResolvedGraph;

    if (packages && packages.length > 0) {
      graph = await this.resolveFromRegistry(packages);
    } else {
      const lockfile = this.detectLockfile();
      if (lockfile) {
        try {
          const lockfileGraph = parse(lockfile.content);
          graph = resolveGraph(lockfileGraph, this.cwd);
        } catch (error) {
          this.warn(
            `Lockfile parse failed: ${error instanceof Error ? error.message : String(error)}; resolving from registry`,
          );
          graph = await this.resolveFromRegistry(packages);
        }
      } else {
        graph = await this.resolveFromRegistry(packages);
      }
    }

    await materializeVirtualStore({
      vfs: this.vfs,
      cwd: this.cwd,
      graph,
      fetchAndExtract: (pkg, targetDir) => this.fetchAndExtract(pkg, targetDir),
      onWarn: (msg) => this.warn(msg),
      execBits: this.execBits,
    });

    const pkgJson = this.readPackageJson();
    const rootDeps =
      packages && packages.length > 0
        ? this.specifiersToDeps(packages)
        : { ...pkgJson?.dependencies, ...pkgJson?.devDependencies };
    const lockfileContent = serializeNpmLockfile(graph, rootDeps, pkgJson?.name, pkgJson?.version);
    await this.vfs.writeFile(`${this.cwd}/package-lock.json`, lockfileContent);
  }

  private async resolveFromRegistry(packages?: string[]): Promise<ResolvedGraph> {
    const pkgJson = this.readPackageJson();
    const rootDeps =
      packages && packages.length > 0
        ? this.specifiersToDeps(packages)
        : { ...pkgJson?.dependencies, ...pkgJson?.devDependencies };

    const cache: ResolveCache = {
      get: async (name) => {
        const cachePath = `${this.cwd}/.npm-cache/${name}.json`;
        try {
          const content = this.fs.readFileSync(cachePath, "utf8") as string;
          const cached = JSON.parse(content);
          if (Date.now() - cached.timestamp < PACKUMENT_CACHE_TTL) {
            return cached.packument as NpmPackument;
          }
        } catch {
          // cache miss
        }
        return null;
      },
      set: async (name, packument) => {
        const cachePath = `${this.cwd}/.npm-cache/${name}.json`;
        const dir = cachePath.substring(0, cachePath.lastIndexOf("/"));
        if (!this.vfs.hot.existsSync(dir)) {
          this.vfs.hot.mkdirSync(dir, { recursive: true });
        }
        this.fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), packument }));
      },
    };

    return walkDependencies(rootDeps, fetch, (msg) => this.warn(msg), cache, this.registryBase);
  }

  private readPackageJson(): {
    name: string;
    version: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  } | null {
    try {
      const content = this.fs.readFileSync(`${this.cwd}/package.json`, "utf8") as string;
      const pkg = JSON.parse(content);
      return {
        name: pkg.name ?? "app",
        version: pkg.version ?? "1.0.0",
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
      };
    } catch {
      return null;
    }
  }

  private specifiersToDeps(specifiers: string[]): Record<string, string> {
    const deps: Record<string, string> = {};
    for (const spec of specifiers) {
      const [name, version] = this.parsePackageSpecifier(spec);
      deps[name] = version ?? "*";
    }
    return deps;
  }

  private buildInstallContext(): InstallContext {
    const lockfile = this.detectLockfile();
    const lockfileGraph: LockfileGraph = lockfile
      ? parse(lockfile.content)
      : { packages: new Map(), catalogs: {}, importers: [], meta: { format: "npm", version: "3" } };
    return {
      lockfileGraph,
      vfs: this.vfs,
      cwd: this.cwd,
      stdout: this.stdout ?? (() => {}),
      stderr: this.stderr ?? (() => {}),
    };
  }

  private detectLockfile(): { content: string | Uint8Array; filename: string } | null {
    for (const name of LOCKFILE_CANDIDATES) {
      const path = `${this.cwd}/${name}`;
      if (!this.vfs.hot.existsSync(path)) continue;
      const isBinary = name.endsWith(".lockb");
      const content = isBinary
        ? new Uint8Array(this.vfs.hot.readFileSync(path) as Uint8Array)
        : (this.vfs.hot.readFileSync(path, "utf8") as string);
      return { content, filename: name };
    }
    return null;
  }

  private async fetchAndExtract(pkg: ResolvedGraphPackage, targetDir: string): Promise<void> {
    if (!pkg.resolvedUrl) {
      throw new Error(`No resolved URL for ${pkg.name}@${pkg.version}`);
    }
    const res = await fetch(pkg.resolvedUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${pkg.resolvedUrl}: ${res.status}`);
    }
    const buffer = new Uint8Array(await res.arrayBuffer());

    if (pkg.integrity) {
      const warnings: string[] = [];
      await verifyIntegrity(buffer, pkg.integrity, pkg.resolvedUrl, warnings);
      for (const warning of warnings) {
        this.warn(warning);
      }
    }

    if (this.vfs.hot.existsSync(targetDir)) {
      this.vfs.hot.rmSync(targetDir, { recursive: true });
    }
    this.vfs.hot.mkdirSync(targetDir, { recursive: true });

    const decompressed = await decompressGzip(buffer);
    extractTarball(decompressed, targetDir, this.vfs, this.execBits);
  }

  private warn(message: string): void {
    if (this.stderr) this.stderr(`[package-manager] ${message}\n`);
    else logger.warn(message);
  }

  private parsePackageSpecifier(spec: string): [string, string | undefined] {
    if (spec.startsWith("jsr:")) {
      const withoutPrefix = spec.slice(4);
      const parts = withoutPrefix.split("@");
      if (withoutPrefix.startsWith("@")) {
        const name = parts.slice(0, 2).join("@");
        const version = parts.slice(2).join("@");
        return [name, version || undefined];
      }
      const [name, version] = parts;
      return [name, version || undefined];
    }

    const parts = spec.split("@");
    if (parts.length === 1) {
      return [spec, undefined];
    }

    if (spec.startsWith("@")) {
      if (parts.length === 2) {
        return [spec, undefined];
      }
      const name = parts.slice(0, 2).join("@");
      const version = parts.slice(2).join("@");
      return [name, version];
    }

    const name = parts[0];
    const version = parts.slice(1).join("@");
    return [name, version];
  }

  private async writeImportMap(): Promise<void> {
    const importMapPath = `${this.cwd}/importmap.json`;
    const packages = this.getImportMapPackageSpecifiers();
    if (packages.length === 0 && this.lastImportMapSpecifiers) {
      // ponytail: package.json can be transiently missing during install; keep
      // the previous importmap rather than writing an empty one.
      return;
    }
    const importMap = this.generateImportMap(packages);
    this.lastImportMapSpecifiers = packages;

    await this.vfs.writeFile(importMapPath, JSON.stringify(importMap, null, 2));
  }

  /**
   * Top-level deps declared in package.json (dependencies + devDependencies),
   * excluding build-only tooling, resolved to their actually-installed version
   * where available (falls back to the declared range, else unversioned).
   * If package.json is missing or empty, returns the last-known-good specifiers.
   */
  private getImportMapPackageSpecifiers(): string[] {
    try {
      const packageJsonPath = `${this.cwd}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, "utf8") as string;
      const pkg = JSON.parse(content);
      const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

      if (Object.keys(declared).length === 0) {
        return this.lastImportMapSpecifiers ?? [];
      }

      return Object.keys(declared)
        .filter((name) => !BUILD_TOOLING_PACKAGES.has(name))
        .map((name) => {
          const version = this.readInstalledVersion(name) ?? declared[name];
          return version ? `${name}@${version}` : name;
        });
    } catch {
      return this.lastImportMapSpecifiers ?? [];
    }
  }

  private readInstalledVersion(name: string): string | undefined {
    try {
      const packageJsonPath = `${this.cwd}/node_modules/${name}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, "utf8") as string;
      return JSON.parse(content).version;
    } catch {
      return undefined;
    }
  }
}

const textDecoder = new TextDecoder();

const decodeTarField = (header: Uint8Array, start: number, length: number): string =>
  textDecoder
    .decode(header.slice(start, start + length))
    .split(String.fromCharCode(0))[0]
    .trim();

/**
 * Decompress gzip data using the native `DecompressionStream` Web API.
 * Replaces the `pako` dependency — one fewer thing to bundle.
 */
const decompressGzip = async (compressed: Uint8Array): Promise<Uint8Array> => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  const decompressed = stream.pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const SRI_ALGORITHMS: ReadonlyArray<{ prefix: string; subtle: string }> = [
  { prefix: "sha512", subtle: "SHA-512" },
  { prefix: "sha384", subtle: "SHA-384" },
  { prefix: "sha256", subtle: "SHA-256" },
  { prefix: "sha1", subtle: "SHA-1" },
];

const bytesToBase64 = (bytes: Uint8Array): string => {
  // ponytail: chunk to avoid String.fromCharCode stack overflow on large buffers
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
};

/**
 * Verify tarball integrity against an npm-style SRI string. Tries algorithms
 * from strongest to weakest. Unsupported algorithms warn and degrade gracefully.
 */
export const verifyIntegrity = async (
  buffer: Uint8Array,
  integrity: string,
  key: string,
  warnings: string[],
): Promise<boolean> => {
  const entries = integrity.trim().split(/\s+/);
  for (const { prefix, subtle } of SRI_ALGORITHMS) {
    const entry = entries.find((c) => c.startsWith(`${prefix}-`));
    if (!entry) continue;
    const expected = entry.slice(prefix.length + 1).split("?")[0];
    // ponytail: buffer is always ArrayBuffer-backed (from fetch.arrayBuffer),
    // but TS's Uint8Array<ArrayBufferLike> type widens to include SharedArrayBuffer.
    const hashBuffer = await crypto.subtle.digest(subtle, buffer as unknown as ArrayBuffer);
    const actual = bytesToBase64(new Uint8Array(hashBuffer));
    if (actual !== expected) {
      throw new Error(`integrity mismatch for ${key}: expected ${expected}, got ${actual}`);
    }
    return true;
  }
  warnings.push(
    `integrity: ${key} uses unsupported algorithm (${integrity}) — verification skipped`,
  );
  return true;
};

const ensureParentDir = (vfs: VfsBus, path: string): void => {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !vfs.hot.existsSync(dir)) {
    vfs.hot.mkdirSync(dir, { recursive: true });
  }
};

/**
 * Minimal USTAR tar extractor. npm tarballs contain a leading `package/`
 * directory that is stripped so files land directly under the target package
 * directory (e.g. `node_modules/foo/package.json`).
 */
function sanitizeEntryPath(rawPath: string): string | null {
  const trimmed = rawPath.replace(/\/+$/, "");
  if (trimmed.startsWith("/")) return null;
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null; // path traversal — never valid in a package
  segments.shift(); // strip the wrapper dir (package/ or whatever name)
  if (segments.length === 0) return null;
  return segments.join("/");
}

export const extractTarball = (
  buffer: Uint8Array,
  targetDir: string,
  vfs: VfsBus,
  execBits?: Map<string, number>,
): void => {
  const hardLinkContent = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < buffer.length) {
    const header = buffer.slice(offset, offset + 512);

    // Two zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) {
      offset += 512;
      if (offset < buffer.length && buffer.slice(offset, offset + 512).every((b) => b === 0)) break;
      continue;
    }

    const name = decodeTarField(header, 0, 100);
    const mode = parseInt(decodeTarField(header, 100, 8).trim(), 8) || 0;
    const size = parseInt(decodeTarField(header, 124, 12).trim(), 8) || 0;
    const type = decodeTarField(header, 156, 1);
    const linkname = decodeTarField(header, 157, 100);
    const prefix = decodeTarField(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const relative = sanitizeEntryPath(fullName);
    const dataOffset = 512 + Math.ceil(size / 512) * 512;

    if (relative === null) {
      offset += dataOffset; // ponytail: silent skip matches burrow; could log at debug if helpful
      continue;
    }
    if (type !== "0" && type !== "1" && type !== "2" && type !== "5") {
      offset += dataOffset;
      continue;
    }

    const targetPath = `${targetDir}/${relative}`;
    const content = buffer.slice(offset + 512, offset + 512 + size);

    if (type === "5" || fullName.endsWith("/")) {
      if (!vfs.hot.existsSync(targetPath)) {
        vfs.hot.mkdirSync(targetPath, { recursive: true });
      }
    } else if (type === "2") {
      const linkParent = relative.substring(0, relative.lastIndexOf("/"));
      const linkTarget = linkParent ? `${linkParent}/${linkname}` : linkname;
      if (typeof vfs.hot.symlinkSync === "function") {
        ensureParentDir(vfs, targetPath);
        vfs.hot.symlinkSync(linkTarget, targetPath, "file");
      } else {
        // ponytail: VfsBus lacks a symlink method; in-tarball symlinks are skipped
      }
    } else if (type === "1") {
      const sourceContent = hardLinkContent.get(linkname);
      if (sourceContent) {
        ensureParentDir(vfs, targetPath);
        vfs.hot.writeFileSync(targetPath, sourceContent);
        hardLinkContent.set(fullName, sourceContent);
        if (execBits && (mode & 0o111) !== 0) {
          execBits.set(targetPath, mode & 0o111);
        }
      } else {
        // ponytail: forward hard-link references are skipped
      }
    } else {
      ensureParentDir(vfs, targetPath);
      vfs.hot.writeFileSync(targetPath, content);
      hardLinkContent.set(fullName, content);
      if (execBits && (mode & 0o111) !== 0) {
        execBits.set(targetPath, mode & 0o111);
      }
    }

    offset += dataOffset;
  }
};
