import { describe, it, expect } from "vitest";
import expectations from "../../apps/compat-harness/src/expectations.json";
import manifest from "../../apps/compat-harness/src/manifest.json";
import { LANES } from "../../apps/compat-harness/src/expected-fail.js";

describe("node-tests expectations ledger", () => {
  const files = new Set(Object.values(manifest.modules).flatMap((m) => m.files));
  const entries = expectations as Record<
    string,
    { lane: string; reason: string; location: string; remediation: string }
  >;

  it("only lists files present in the manifest", () => {
    for (const file of Object.keys(entries)) expect(files.has(file), file).toBe(true);
  });

  it("tags every entry with a lane, reason, location and remediation", () => {
    for (const [file, entry] of Object.entries(entries)) {
      expect(LANES, file).toContain(entry.lane);
      expect(entry.reason.length, file).toBeGreaterThan(10);
      expect(entry.reason, file).not.toContain("\n");
      expect(entry.location.length, file).toBeGreaterThan(0);
      expect(entry.remediation.length, file).toBeGreaterThan(0);
    }
  });

  it("covers the process-exit, timers and next-tick family", () => {
    for (const m of ["process-exit", "timers", "next-tick"]) {
      expect(manifest.modules[m as keyof typeof manifest.modules].files.length).toBeGreaterThan(0);
    }
  });
});
