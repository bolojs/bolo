import { describe, it, expect } from "vitest";
import type { SandboxBackend, SandboxSnapshot } from "@bolojs/runtime";
import {
  SANDBOX_CASES,
  SNAPSHOT_CASES,
  matchesExpected,
  runConformance,
  runSnapshotRoundTrip,
} from "./sandbox-conformance.js";

/**
 * MemoryBackend: a reference SandboxBackend used to prove the harness itself.
 * It evaluates code in a persistent scope so snapshot/restore has real state
 * to carry — serialized as JSON bytes, format-tagged like a real engine.
 */
class MemoryBackend implements SandboxBackend {
  private scope: Record<string, unknown> = {};

  async run(code: string) {
    try {
      const fn = new Function("globalThis", `"use strict"; return (${code});`);
      return { result: String(fn(this.scope)) };
    } catch (err) {
      // Statements (not expressions) run without a return value.
      try {
        new Function("globalThis", `"use strict"; ${code}`)(this.scope);
        return { result: "undefined" };
      } catch {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return {
      bytes: new TextEncoder().encode(JSON.stringify(this.scope)),
      format: "memory-backend@1",
    };
  }

  async restore(snapshot: SandboxSnapshot): Promise<void> {
    if (snapshot.format !== "memory-backend@1") {
      throw new Error(`format mismatch: ${snapshot.format}`);
    }
    this.scope = JSON.parse(new TextDecoder().decode(snapshot.bytes)) as Record<string, unknown>;
  }

  dispose(): void {}
}

describe("sandbox conformance harness", () => {
  it("matchesExpected compares strings exactly and errors by regex", () => {
    expect(matchesExpected({ result: "42" }, { result: "42" })).toBe(true);
    expect(matchesExpected({ result: "42" }, { result: "41" })).toBe(false);
    expect(matchesExpected({ error: /boom/ }, { error: "Error: boom" })).toBe(true);
    expect(matchesExpected({ result: "1" }, { error: "x" })).toBe(false);
  });

  it("runConformance reports per-case pass/fail against declared expectations", async () => {
    const results = await runConformance(SANDBOX_CASES, () => new MemoryBackend());
    expect(results).toHaveLength(SANDBOX_CASES.length);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("runConformance flags a divergent backend", async () => {
    const liar: SandboxBackend = {
      run: () => Promise.resolve({ result: "wrong" }),
      dispose: () => {},
    };
    const results = await runConformance([SANDBOX_CASES[0]!], () => liar);
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.actual.result).toBe("wrong");
  });

  it("runSnapshotRoundTrip diffs restored vs uninterrupted execution", async () => {
    const result = await runSnapshotRoundTrip(
      {
        name: "state-survives",
        setup: "globalThis.__n = 41;",
        then: "globalThis.__n + 1",
        expected: { result: "42" },
      },
      () => new MemoryBackend(),
    );
    expect(result.pass).toBe(true);
  });

  it("runSnapshotRoundTrip catches a backend that loses state on restore", async () => {
    class ForgetfulBackend extends MemoryBackend {
      override async restore(): Promise<void> {}
    }
    const result = await runSnapshotRoundTrip(SNAPSHOT_CASES[0]!, () => new ForgetfulBackend());
    expect(result.pass).toBe(false);
  });

  it("runSnapshotRoundTrip rejects backends without snapshot support", async () => {
    const plain: SandboxBackend = {
      run: () => Promise.resolve({ result: "undefined" }),
      dispose: () => {},
    };
    await expect(runSnapshotRoundTrip(SNAPSHOT_CASES[0]!, () => plain)).rejects.toThrow(
      "does not implement snapshot/restore",
    );
  });
});
