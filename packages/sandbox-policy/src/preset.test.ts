import { describe, it, expect } from "vitest";
import { SandboxPresets, KnownAgentPolicies } from "./types.js";

describe("SandboxPresets", () => {
  it("none preset is null", () => {
    expect(SandboxPresets.none).toBeNull();
  });

  it("moderate preset allows fetch", () => {
    const p = SandboxPresets.moderate!;
    expect(p).not.toBeNull();
    expect(p.fetch.mode).toBe("allow");
    expect(p.memory.limitMb).toBe(128);
    expect(p.cpu.maxOpsPerInterval).toBe(1_000_000);
    expect(p.cpu.intervalMs).toBe(1000);
    expect(p.fs.mode).toBe("readOnly");
  });

  it("strict preset denies fetch", () => {
    const p = SandboxPresets.strict!;
    expect(p).not.toBeNull();
    expect(p.fetch.mode).toBe("deny");
    expect(p.memory.limitMb).toBe(64);
    expect(p.cpu.maxOpsPerInterval).toBe(100_000);
    expect(p.fs.mode).toBe("readOnly");
  });
});

describe("KnownAgentPolicies", () => {
  it("opencode has empty overrides", () => {
    expect(KnownAgentPolicies.opencode).toEqual({});
  });

  it("claude-code overrides memory", () => {
    expect(KnownAgentPolicies["claude-code"].memory?.limitMb).toBe(256);
  });

  it("pi overrides fetch with allowList", () => {
    const fetch = KnownAgentPolicies.pi.fetch;
    expect(fetch?.mode).toBe("allow");
    expect(fetch?.allowList).toContain("https://api.example.com");
  });
});
