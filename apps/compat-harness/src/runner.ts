/// <reference types="vite/client" />

import type { CompatHarness } from "./main.js";
import { commonIndexSource, countdownSource, internalShimSources } from "./test-common.js";
import { assertCanariesFail, runCanaries } from "./canaries.js";
import { classifyNodeTest } from "./classify.js";
import { expectedFailEntry, type ExpectedFailEntry } from "./expected-fail.js";

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
  /**
   * Ledger entry (src/expectations.json) when this file is a known
   * expected failure, on any lane. Lane A/B still count as failures; only
   * lane C is platform-bound.
   */
  expectedFail?: ExpectedFailEntry;
  /** The ledger expected a failure but the test passed — stale expectation. */
  unexpectedPass?: boolean;
}

const expectedFailOf = (file: string, status: TestResult["status"]) => {
  const entry = expectedFailEntry(file);
  if (!entry) return {};
  return status === "pass"
    ? { expectedFail: entry, unexpectedPass: true }
    : { expectedFail: entry };
};

export class NodeTestRunner {
  private manifest: ModuleManifest;
  private harness: CompatHarness;
  private inlineFiles: Record<string, string>;
  private binaryFiles: Record<string, string>;
  private binaryCache = new Map<string, Uint8Array>();
  /** VFS paths of vendored non-manifest files (common helpers, fixtures, test siblings). */
  private supportTextFiles: { path: string; contents: string }[];
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
    // Binary fixtures cannot be inlined as ?raw text (UTF-8 decoding would
    // corrupt them); Vite serves them by URL and the bytes are fetched on use.
    this.binaryFiles = import.meta.glob(
      "/node-tests/**/*.{png,gif,jpg,jpeg,webp,ico,bin,dat,der,p12,pfx,wasm}",
      { query: "?url", import: "default", eager: true },
    ) as Record<string, string>;

    const manifestFiles = new Set(Object.values(manifest.modules).flatMap((m) => m.files));
    this.supportTextFiles = Object.entries(this.inlineFiles)
      .filter(([key]) => !(key in this.binaryFiles))
      .map(([key, contents]) => ({ path: key.slice("/node-tests".length), contents }))
      .filter(
        ({ path }) =>
          path.startsWith("/test/") && !path.endsWith(".md") && !manifestFiles.has(path.slice(1)),
      );
  }

  async boot(): Promise<void> {
    await this.harness.boot();
  }

  /** Runs the canary suite; throws if any canary is scored as a pass (invalid run). */
  async verifyCanaries(): Promise<void> {
    await this.harness.write("/test/common/index.js", commonIndexSource);
    assertCanariesFail(await runCanaries(this.harness));
  }

  async runAll(
    filter?: RegExp,
    moduleName?: string,
  ): Promise<{ module: string; results: TestResult[] }[]> {
    // Per-module runs skip the canary gate: the CLI verifies canaries once on
    // the page up front, and re-running them per module would multiply boot
    // cost by the module count.
    if (moduleName === undefined) await this.verifyCanaries();

    const moduleResults: { module: string; results: TestResult[] }[] = [];

    for (const [name, { files }] of Object.entries(this.manifest.modules)) {
      if (moduleName !== undefined && name !== moduleName) continue;
      const results: TestResult[] = [];
      for (const file of files) {
        if (filter && !filter.test(file)) continue;
        results.push(await this.runOne(name, file));
      }
      if (results.length > 0) moduleResults.push({ module: name, results });
    }

    return moduleResults;
  }

  private async runOne(moduleName: string, file: string): Promise<TestResult> {
    if (this.isolation === "fresh-boot") await this.reboot();
    const source = await this.loadSource(file, this.manifest.nodeVersion);
    const filePath = `/${file}`;
    await this.writeSupportFiles();
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
        ...expectedFailOf(file, "fail"),
      };
    }
    const { exitCode, output, duration } = outcome;
    const status = classifyNodeTest(exitCode, output);
    return {
      file,
      module: moduleName,
      status,
      exitCode,
      output,
      duration,
      ...expectedFailOf(file, status),
    };
  }

  /**
   * Materializes the test support tree the manifest's files require:
   * `test/common` helpers, `test/fixtures`, non-manifest sibling files
   * (e.g. test-tls-ticket.js), and the `internal/*` shim modules that resolve
   * through plain node_modules lookup. A fresh boot wipes the VFS, so this
   * runs once per test.
   */
  private async writeSupportFiles(): Promise<void> {
    await this.harness.write("/test/common/index.js", commonIndexSource);
    await this.harness.write("/test/common/countdown.js", countdownSource);
    for (const { path, contents } of this.supportTextFiles) {
      await this.harness.write(path, contents);
    }
    for (const [key, url] of Object.entries(this.binaryFiles)) {
      await this.harness.write(key.slice("/node-tests".length), await this.loadBinary(url));
    }
    for (const specifier of Object.keys(internalShimSources)) {
      // A specifier containing ':' (e.g. "node:test") cannot resolve as a
      // plain file: the bundler's bare-package walk only matches existing
      // directories under node_modules, so write those as a package dir.
      const path = specifier.includes(":")
        ? `/test/node_modules/${specifier}/index.js`
        : `/test/node_modules/${specifier}.js`;
      await this.harness.write(path, internalShimSources[specifier]);
    }
  }

  private async loadBinary(url: string): Promise<Uint8Array> {
    const cached = this.binaryCache.get(url);
    if (cached) return cached;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch binary fixture ${url}: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.binaryCache.set(url, bytes);
    return bytes;
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
    // Non-vendored files are fetched live from GitHub; a transient network
    // failure must not sink the whole module run.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) return response.text();
        lastError = new Error(`Failed to fetch ${url}: ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }
}
