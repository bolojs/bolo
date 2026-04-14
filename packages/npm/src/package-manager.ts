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

    await runNpmCli(args, {
      fs: this.fs,
      cwd: this.cwd,
      stdout: this.stdout ? (chunk: string) => this.stdout!(chunk) : undefined,
      stderr: this.stderr ? (chunk: string) => this.stdout!(chunk) : undefined,
    });

    await this.writeImportMap();
  }

  /**
   * Generate import map with esm.sh CDN fallback URLs.
   */
  generateImportMap(packages: string[]): ImportMap {
    const imports: Record<string, string> = {};

    for (const pkg of packages) {
      const [name, version] = this.parsePackageSpecifier(pkg);
      imports[name] = this.generateEsmShUrl(name, version);
    }

    return { imports };
  }

  private generateEsmShUrl(name: string, version?: string): string {
    const versionPart = version ? `@${version}` : '';
    return `https://esm.sh/${name}${versionPart}`;
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
      return ['install', ...packages];
    }

    const deps = this.getDependenciesFromPackageJson();
    return ['install', ...deps];
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
    const packages = await this.getInstalledPackages();
    const importMap = this.generateImportMap(packages);

    await this.vfs.writeFile(importMapPath, JSON.stringify(importMap, null, 2));
  }

  private async getInstalledPackages(): Promise<string[]> {
    try {
      const nodeModulesPath = `${this.cwd}/node_modules`;
      const entries = await this.vfs.readdir(nodeModulesPath);
      return typeof entries[0] === 'string' ? (entries as string[]) : (entries as { name: string }[]).map((e) => e.name);
    } catch (error) {
      return [];
    }
  }
}
