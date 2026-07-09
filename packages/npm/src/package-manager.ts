import type { VfsBus } from '@browser-containers/vfs-bus';
import { createFsFromVolume } from 'memfs';
import { runNpmCli } from 'npm-in-browser';

export interface ImportMap {
  imports: Record<string, string>;
}

export interface PackageManagerOptions {
  vfs: VfsBus;
  cwd?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

const DEFAULT_CWD = '/home/web/app';

// Packages that import `react` internally must be externalized (esm.sh `*` prefix)
// so the browser re-resolves their `react` import through this importmap's single
// pinned entry instead of esm.sh bundling its own copy — otherwise invalid-hook-call.
const REACT_DEPENDENT_PACKAGES = new Set(['react-dom']);

// esm.sh's `*` external prefix leaves ALL of the package's own bare imports
// unresolved, not just `react` — react-dom's build also imports `scheduler`
// verbatim. These peers need their own (non-externalized) importmap entry.
const EXTERNALIZED_PEER_DEPS: Record<string, string[]> = {
  'react-dom': ['scheduler'],
};

// Build-only tooling that must be installed but has no browser-runtime import.
const BUILD_TOOLING_PACKAGES = new Set(['vite', 'typescript', 'esbuild']);

/**
 * Browser-side package manager using npm-in-browser.
 * Install packages and generate import maps for browser execution.
 */
export class PackageManager {
  private vfs: VfsBus;
  private cwd: string;
  private stdout?: (chunk: string) => void;
  private stderr?: (chunk: string) => void;
  private fs: ReturnType<typeof createFsFromVolume>;

  constructor(options: PackageManagerOptions) {
    this.vfs = options.vfs;
    this.cwd = options.cwd ?? DEFAULT_CWD;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.fs = createFsFromVolume(this.vfs['vol']) as ReturnType<typeof createFsFromVolume>;
  }

  /**
   * Install packages using npm-in-browser.
   * If no packages are specified, reads from package.json in VFS.
   */
  async install(packages?: string[]): Promise<void> {
    const args = this.buildInstallArgs(packages);

    await this.vfs.writeFile(`${this.cwd}/.npmrc`, 'audit=false\nfund=false\n').catch(() => {});

    await runNpmCli(args, {
      fs: this.fs,
      cwd: this.cwd,
      stdout: this.stdout ? (chunk: string) => this.stdout!(chunk) : undefined,
      stderr: this.stderr ? (chunk: string) => this.stderr!(chunk) : undefined,
    });

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
      imports[name] = this.generateEsmShUrl(name, version, external);
      imports[`${name}/`] = this.generateEsmShUrl(name, version, external, true);

      for (const peer of EXTERNALIZED_PEER_DEPS[name] ?? []) {
        if (imports[peer]) continue;
        const peerVersion = this.readInstalledVersion(peer);
        imports[peer] = this.generateEsmShUrl(peer, peerVersion);
      }
    }

    return { imports };
  }

  private generateEsmShUrl(name: string, version?: string, external = false, trailingSlash = false): string {
    const versionPart = version ? `@${version}` : '';
    const prefix = external ? '*' : '';
    const suffix = trailingSlash ? '/' : '';
    return `https://esm.sh/${prefix}${name}${versionPart}${suffix}`;
  }

  private parsePackageSpecifier(spec: string): [string, string | undefined] {
    if (spec.startsWith('jsr:')) {
      const withoutPrefix = spec.slice(4);
      const parts = withoutPrefix.split('@');
      if (withoutPrefix.startsWith('@')) {
        const name = parts.slice(0, 2).join('@');
        const version = parts.slice(2).join('@');
        return [name, version || undefined];
      }
      const [name, version] = parts;
      return [name, version || undefined];
    }

    const parts = spec.split('@');
    if (parts.length === 1) {
      return [spec, undefined];
    }

    if (spec.startsWith('@')) {
      if (parts.length === 2) {
        return [spec, undefined];
      }
      const name = parts.slice(0, 2).join('@');
      const version = parts.slice(2).join('@');
      return [name, version];
    }

    const name = parts[0];
    const version = parts.slice(1).join('@');
    return [name, version];
  }

  private buildInstallArgs(packages?: string[]): string[] {
    if (packages && packages.length > 0) {
      return ['install', '--no-audit', ...packages];
    }

    const deps = this.getDependenciesFromPackageJson();
    return ['install', '--no-audit', ...deps];
  }

  private getDependenciesFromPackageJson(): string[] {
    try {
      const packageJsonPath = `${this.cwd}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, 'utf8') as string;
      const pkg = JSON.parse(content);

      const deps: string[] = [];

      if (pkg.dependencies) {
        deps.push(
          ...Object.keys(pkg.dependencies).map(name => {
            const version = pkg.dependencies[name];
            return version ? `${name}@${version}` : name;
          })
        );
      }

      if (pkg.devDependencies) {
        deps.push(
          ...Object.keys(pkg.devDependencies).map(name => {
            const version = pkg.devDependencies[name];
            return version ? `${name}@${version}` : name;
          })
        );
      }

      return deps;
    } catch (error) {
      console.warn('Could not read package.json:', error);
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
      const content = this.fs.readFileSync(packageJsonPath, 'utf8') as string;
      const pkg = JSON.parse(content);
      const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

      return Object.keys(declared)
        .filter(name => !BUILD_TOOLING_PACKAGES.has(name))
        .map(name => {
          const version = this.readInstalledVersion(name) ?? declared[name];
          return version ? `${name}@${version}` : name;
        });
    } catch (error) {
      console.warn('Could not read package.json:', error);
      return [];
    }
  }

  private readInstalledVersion(name: string): string | undefined {
    try {
      const packageJsonPath = `${this.cwd}/node_modules/${name}/package.json`;
      const content = this.fs.readFileSync(packageJsonPath, 'utf8') as string;
      return JSON.parse(content).version;
    } catch (error) {
      return undefined;
    }
  }
}
