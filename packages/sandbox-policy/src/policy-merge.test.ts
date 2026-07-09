import { describe, it, expect } from "vitest";
import { mergePolicy } from "./policy-merge.js";
import { SandboxPresets, KnownAgentPolicies } from "./types.js";

describe("mergePolicy", () => {
  it("returns null when preset is null", () => {
    const result = mergePolicy(null, undefined, undefined);
    expect(result).toBeNull();
  });

  it("returns a copy of the preset when no overrides", () => {
    const result = mergePolicy(SandboxPresets.moderate, undefined, undefined);
    expect(result).toEqual(SandboxPresets.moderate);
    expect(result).not.toBe(SandboxPresets.moderate);
  });

  it("merges known agent policy on top of preset", () => {
    const known = KnownAgentPolicies["claude-code"];
    const result = mergePolicy(SandboxPresets.moderate, known, undefined);
    expect(result).not.toBeNull();
    expect(result!.memory.limitMb).toBe(256);
    expect(result!.fetch.mode).toBe("allow");
  });

  it("merges override on top of preset and known", () => {
    const result = mergePolicy(
      SandboxPresets.moderate,
      { memory: { limitMb: 256 } },
      { fetch: { mode: "deny" } },
    );
    expect(result).not.toBeNull();
    expect(result!.fetch.mode).toBe("deny");
    expect(result!.memory.limitMb).toBe(256);
    expect(result!.cpu.maxOpsPerInterval).toBe(1_000_000);
  });

  it("override takes precedence over known and preset", () => {
    const result = mergePolicy(
      SandboxPresets.strict,
      { cpu: { maxOpsPerInterval: 500_000, intervalMs: 500 } },
      { cpu: { maxOpsPerInterval: 50_000, intervalMs: 2000 } },
    );
    expect(result).not.toBeNull();
    expect(result!.cpu.maxOpsPerInterval).toBe(50_000);
    expect(result!.cpu.intervalMs).toBe(2000);
  });

  it("handles undefined known and override gracefully", () => {
    const result = mergePolicy(SandboxPresets.strict, undefined, undefined);
    expect(result).toEqual(SandboxPresets.strict);
  });
});
