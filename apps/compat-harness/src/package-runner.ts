import packageMatrix from "./package-matrix.json" with { type: "json" };
import type { CompatHarness } from "./main.js";

export interface PackageResult {
  name: string;
  class: string;
  status: "pass" | "fail" | "skip";
  error?: string;
  duration?: number;
}

export interface PackageMatrix {
  version: string;
  packages: { name: string; class: string; probe: string }[];
}

export class PackageMatrixRunner {
  private matrix: PackageMatrix;
  private harness: CompatHarness;

  constructor() {
    this.matrix = packageMatrix as PackageMatrix;
    this.harness = window.__compatHarness;
  }

  async boot(): Promise<void> {
    await this.harness.boot();
  }

  async runAll(): Promise<PackageResult[]> {
    const results: PackageResult[] = [];

    for (const pkg of this.matrix.packages) {
      const path = `/probe/${pkg.name}.mjs`;
      const source = this.buildProbe(pkg.name, pkg.probe);
      const start = performance.now();

      try {
        await this.harness.write(path, source);
        const { exitCode, output } = await this.harness.exec(path);
        const duration = performance.now() - start;
        const status = this.classify(exitCode, output);
        results.push({ name: pkg.name, class: pkg.class, status, duration });
      } catch (err) {
        const duration = performance.now() - start;
        results.push({
          name: pkg.name,
          class: pkg.class,
          status: "fail",
          error: err instanceof Error ? err.message : String(err),
          duration,
        });
      }
    }

    return results;
  }

  async teardown(): Promise<void> {
    await this.harness.teardown();
  }

  private buildProbe(name: string, probe: string): string {
    return `import ${this.importIdentifier(name)} from 'https://esm.sh/${name}';
try {
  ${probe};
  console.log('PASS');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
`;
  }

  private importIdentifier(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");
    return /^[a-zA-Z_$]/.test(safe) ? safe : `_${safe}`;
  }

  private classify(exitCode: number, output: string): PackageResult["status"] {
    if (exitCode === 0) return "pass";
    if (output.includes("SKIP") || output.includes("# skip")) return "skip";
    return "fail";
  }
}
