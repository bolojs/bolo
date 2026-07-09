import { describe, it, expect } from "vitest";
import { SandboxPresets } from "./types.js";
import { createSwGate } from "./sw-gate.js";

describe("deny-all integration", () => {
  it("blocks all fetch when policy.fetch.mode is deny", () => {
    const policy = SandboxPresets.strict!;
    expect(policy.fetch.mode).toBe("deny");

    const gate = createSwGate(policy);
    const req = new Request("https://example.com/api/data");
    const result = gate(req);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(result!.status).not.toBe(200);
  });

  it("blocks fetch with custom deny URL", async () => {
    const gate = createSwGate({
      fetch: { mode: "deny" },
      memory: { limitMb: 64 },
      cpu: { maxOpsPerInterval: 100_000, intervalMs: 1000 },
      fs: { mode: "readOnly" },
    });

    const result = gate(new Request("https://any-site.com/path"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns null (passthrough) when policy is null", () => {
    const gate = createSwGate(null);
    const result = gate(new Request("https://example.com"));
    expect(result).toBeNull();
  });
});
