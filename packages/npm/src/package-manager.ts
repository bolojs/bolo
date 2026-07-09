import type { VfsBus } from "@browser-containers/vfs-bus";
import { createFsFromVolume } from "memfs";
import { runNpmCli } from "npm-in-browser";
import { parse, resolve } from "@unjs/lockfile";
import type { InstallablePackage, LockfileGraph } from "@unjs/lockfile";
import { inflate } from "pako";
import { buildEsmShUrl } from "./esm-sh.js";

export interface ImportMap {
  imports: Record<string, string>;
}

export type InstallStrategy = "npm-in-browser" | "lockfile-only";

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
}

const DEFAULT_CWD = "/home/web/app";

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
 * - `npm-in-browser`: runs the real npm CLI against the VFS (default).
 * - `lockfile-only`: parses a lockfile with `@unjs/lockfile`, fetches tarballs
 *   via `fetch`, and extracts them into `node_modules/` using `pako`.
 */
export class PackageManager {
  private vfs: VfsBus;
  private cwd: string;
  private stdout?: (chunk: string) => void;
  private stderr?: (chunk: string) => void;
  private fs: ReturnType<typeof createFsFromVolume>;
  private installStrategy: InstallStrategy;

  constructor(options: PackageManagerOptions) {
    this.vfs = options.vfs;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.fs = createFsFromVolume(this.vfs["vol"]) as ReturnType<typeof createFsFromVolume>;
    this.installStrategy = options.installStrategy ?? "npm-in-browser";
  }

  /**
   * Install packages. If no packages are specified, the npm-in-browser path
   * reads from package.json; the lockfile-only path reads from the detected
   * lockfile in the VFS.
   */
  async install(packages?: string[]): Promise<void> {
    if (this.installStrategy === "lockfile-only") {
      await this.installLockfileOnly();
    } else {
      await this.installNpmCli(packages);
    }

    await this.writeImportMap();
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

  private async installNpmCli(packages?: string[]): Promise<void> {
    const args = this.buildInstallArgs(packages);

    await this.vfs
      .writeFile(
        `${this.cwd}/.npmrc`,
        "audit=false\nfund=false\n@jsr:registry=https://npm.jsr.io\n",
      )
      .catch(() => {});

    await runNpmCli(args, {
      fs: this.fs,
      cwd: this.cwd,
      stdout: this.stdout ? (chunk: string) => this.stdout!(chunk) : undefined,
      stderr: this.stderr ? (chunk: string) => this.stderr!(chunk) : undefined,
    });
  }

  private async installLockfileOnly(): Promise<void> {
    const lockfile = this.detectLockfile();
    if (!lockfile) {
      this.warn("No lockfile found; falling back to npm-in-browser");
      await this.installNpmCli();
      return;
    }

    try {
      const graph = parse(lockfile.content);
      const installables = resolve(graph, this.cwd);

      for (const pkg of installables) {
        await this.fetchAndExtract(pkg);
      }
    } catch (error) {
      this.warn(
        `lockfile-only install failed: ${error instanceof Error ? error.message : String(error)}; falling back to npm-in-browser`,
      );
      await this.installNpmCli();
    }
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

  private async fetchAndExtract(pkg: InstallablePackage): Promise<void> {
    const res = await fetch(pkg.url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${pkg.url}: ${res.status}`);
    }
    const buffer = new Uint8Array(await res.arrayBuffer());

    const targetDir = `${this.cwd}/node_modules/${pkg.name}`;
    if (this.vfs.hot.existsSync(targetDir)) {
      this.vfs.hot.rmSync(targetDir, { recursive: true });
    }
    this.vfs.hot.mkdirSync(targetDir, { recursive: true });

    const decompressed = inflate(buffer, { windowBits: 15 + 32 });
    extractTarball(decompressed, targetDir, this.vfs);
  }

  private warn(message: string): void {
    const line = `[package-manager] ${message}\n`;
    if (this.stderr) this.stderr(line);
    else console.warn(line);
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

  private buildInstallArgs(packages?: string[]): string[] {
    if (packages && packages.length > 0) {
      return ["install", "--no-audit", ...packages];
    }

    const deps = this.getDependenciesFromPackageJson();
    return ["install", "--no-audit", ...deps];
  }

  private getDependenciesFromPackageJson(): string[] {
    try {
      const packageJsonPath = `${this.cwd}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, "utf8") as string;
      const pkg = JSON.parse(content);

      const deps: string[] = [];

      if (pkg.dependencies) {
        deps.push(
          ...Object.keys(pkg.dependencies).map((name) => {
            const version = pkg.dependencies[name];
            return version ? `${name}@${version}` : name;
          }),
        );
      }

      if (pkg.devDependencies) {
        deps.push(
          ...Object.keys(pkg.devDependencies).map((name) => {
            const version = pkg.devDependencies[name];
            return version ? `${name}@${version}` : name;
          }),
        );
      }

      return deps;
    } catch (error) {
      console.warn("Could not read package.json:", error);
      return [];
    }
  }

  private async writeImportMap(): Promise<void> {
    const importMapPath = `${this.cwd}/importmap.json`;
    const packages = this.getImportMapPackageSpecifiers();
    const importMap = this.generateImportMap(packages);

    await this.vfs.writeFile(importMapPath, JSON.stringify(importMap, null, 2));
  }

  /**
   * Top-level deps declared in package.json (dependencies + devDependencies),
   * excluding build-only tooling, resolved to their actually-installed version
   * where available (falls back to the declared range, else unversioned).
   */
  private getImportMapPackageSpecifiers(): string[] {
    try {
      const packageJsonPath = `${this.cwd}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, "utf8") as string;
      const pkg = JSON.parse(content);
      const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

      return Object.keys(declared)
        .filter((name) => !BUILD_TOOLING_PACKAGES.has(name))
        .map((name) => {
          const version = this.readInstalledVersion(name) ?? declared[name];
          return version ? `${name}@${version}` : name;
        });
    } catch (error) {
      console.warn("Could not read package.json:", error);
      return [];
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
 * Minimal USTAR tar extractor. npm tarballs contain a leading `package/`
 * directory that is stripped so files land directly under the target package
 * directory (e.g. `node_modules/foo/package.json`).
 */
const extractTarball = (buffer: Uint8Array, targetDir: string, vfs: VfsBus): void => {
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
    const size = parseInt(decodeTarField(header, 124, 12).trim(), 8) || 0;
    const type = decodeTarField(header, 156, 1);
    const prefix = decodeTarField(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const relative = fullName.replace(/^package\//, "");

    if (type !== "0" && type !== "5") {
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    if (!relative) {
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    const targetPath = `${targetDir}/${relative}`;
    const content = buffer.slice(offset + 512, offset + 512 + size);

    if (type === "5" || fullName.endsWith("/")) {
      if (!vfs.hot.existsSync(targetPath)) {
        vfs.hot.mkdirSync(targetPath, { recursive: true });
      }
    } else {
      const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
      if (dir && !vfs.hot.existsSync(dir)) {
        vfs.hot.mkdirSync(dir, { recursive: true });
      }
      vfs.hot.writeFileSync(targetPath, content);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }
};
