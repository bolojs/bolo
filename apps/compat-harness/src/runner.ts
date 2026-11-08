/// <reference types="vite/client" />

import type { CompatHarness } from "./main.js";
import { commonIndexSource } from "./test-common.js";
import { assertCanariesFail, runCanaries } from "./canaries.js";
import { classifyNodeTest } from "./classify.js";

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
  private readonly testTimeoutMs: number;
  private readonly isolation: "fresh-boot" | "shared";

  constructor(
    manifest: ModuleManifest,
    options: { testTimeoutMs?: number; isolation?: "fresh-boot" | "shared" } = {},
  ) {
    this.testTimeoutMs = options.testTimeoutMs ?? 30_000;
    this.isolation = options.isolation ?? "fresh-boot";
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

  /** Runs the canary suite; throws if any canary is scored as a pass (invalid run). */
  async verifyCanaries(): Promise<void> {
    await this.harness.write("/test/common/index.js", commonIndexSource);
    assertCanariesFail(await runCanaries(this.harness));
  }

  async runAll(): Promise<{ module: string; results: TestResult[] }[]> {
    await this.verifyCanaries();

    const moduleResults: { module: string; results: TestResult[] }[] = [];

    for (const [moduleName, { files }] of Object.entries(this.manifest.modules)) {
      const results: TestResult[] = [];
      for (const file of files) {
        results.push(await this.runOne(moduleName, file));
      }
      moduleResults.push({ module: moduleName, results });
    }

    return moduleResults;
  }

  private async runOne(moduleName: string, file: string): Promise<TestResult> {
    if (this.isolation === "fresh-boot") await this.reboot();
    const source = await this.loadSource(file, this.manifest.nodeVersion);
    const filePath = `/${file}`;
    await this.harness.write("/test/common/index.js", commonIndexSource);
    await this.harness.write(filePath, source);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    const outcome = await Promise.race([
      this.harness.exec(filePath),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.testTimeoutMs);
      }),
    ]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      // The hung program cannot be reclaimed on the main thread (v0.2.0);
      // a fresh boot for the next test keeps it from poisoning the run.
      return {
        file,
        module: moduleName,
        status: "fail",
        exitCode: -1,
        output: `TIMEOUT after ${this.testTimeoutMs}ms`,
        duration: performance.now() - start,
      };
    }
    const { exitCode, output, duration } = outcome;
    return {
      file,
      module: moduleName,
      status: classifyNodeTest(exitCode, output),
      exitCode,
      output,
      duration,
    };
  }

  private async reboot(): Promise<void> {
    // Teardown of a wedged container may itself hang; never wait on it forever.
    await Promise.race([
      this.harness.teardown().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    this.harness.ready = false;
    await this.harness.boot();
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
}
