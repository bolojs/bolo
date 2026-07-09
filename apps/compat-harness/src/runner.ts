/// <reference types="vite/client" />

import type { CompatHarness } from "./main.js";
import { commonIndexSource } from "./test-common.js";

export interface ModuleManifest {
  version: string;
  nodeVersion: string;
  modules: Record<string, { files: string[] }>;
}

export interface TestResult {
  file: string;
  module: string;
  status: "pass" | "fail" | "skip";
  exitCode: number;
  output: string;
  duration?: number;
}

export class NodeTestRunner {
  private manifest: ModuleManifest;
  private harness: CompatHarness;
  private inlineFiles: Record<string, string>;

  constructor(manifest: ModuleManifest) {
    this.manifest = manifest;
    this.harness = window.__compatHarness;
    this.inlineFiles = import.meta.glob("/node-tests/**/*", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
  }

  async boot(): Promise<void> {
    await this.harness.boot();
  }

  async runAll(): Promise<{ module: string; results: TestResult[] }[]> {
    await this.harness.write("/test/common/index.js", commonIndexSource);

    const moduleResults: { module: string; results: TestResult[] }[] = [];

    for (const [moduleName, { files }] of Object.entries(this.manifest.modules)) {
      const results: TestResult[] = [];
      for (const file of files) {
        const source = await this.loadSource(file, this.manifest.nodeVersion);
        const filePath = `/${file}`;
        await this.harness.write(filePath, source);
        const { exitCode, output, duration } = await this.harness.exec(filePath);
        const status = this.classify(exitCode, output);
        results.push({ file, module: moduleName, status, exitCode, output, duration });
      }
      moduleResults.push({ module: moduleName, results });
    }

    return moduleResults;
  }

  async teardown(): Promise<void> {
    await this.harness.teardown();
  }

  private async loadSource(file: string, version: string): Promise<string> {
    const inlineKey = `/node-tests/${file}`;
    const inline = this.inlineFiles[inlineKey];
    if (inline !== undefined) {
      return inline;
    }

    const url = `https://raw.githubusercontent.com/nodejs/node/v${version}/${file}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response.text();
  }

  private classify(exitCode: number, output: string): TestResult["status"] {
    if (exitCode === 0) return "pass";
    if (output.includes("SKIP") || output.includes("# skip")) return "skip";
    return "fail";
  }
}
