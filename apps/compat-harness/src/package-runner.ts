import packageMatrix from "./package-matrix.json" with { type: "json" };
import type { CompatHarness } from "./main.js";

export interface PackageResult {
  name: string;
  class: string;
  status: "pass" | "fail" | "skip";
  error?: string;
  duration?: number;
}

export interface PackageEntry {
  name: string;
  class: string;
  probe?: string;
  source?: string;
  import?: boolean;
}

export interface PackageMatrix {
  version: string;
  packages: PackageEntry[];
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
      const source = this.buildProbe(pkg);
      const start = performance.now();

      try {
        await this.harness.write(path, source);
        const { exitCode, output } = await this.harness.exec(path);
        const duration = performance.now() - start;
        const status = this.classify(exitCode, output);
        const result: PackageResult = { name: pkg.name, class: pkg.class, status, duration };
        if (status === "fail") {
          result.error = output.trim() || "probe failed";
        }
        results.push(result);
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

  private buildProbe(pkg: PackageEntry): string {
    if (pkg.source) return pkg.source;
    const importLine =
      pkg.import !== false
        ? `import ${this.importIdentifier(pkg.name)} from 'https://esm.sh/${pkg.name}';`
        : "";
    return `${importLine}
try {
  ${pkg.probe};
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
