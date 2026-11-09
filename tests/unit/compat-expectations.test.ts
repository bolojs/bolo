import { describe, it, expect } from "vitest";
import expectations from "../../apps/compat-harness/src/expectations.json";
import manifest from "../../apps/compat-harness/src/manifest.json";

describe("node-tests expectations", () => {
  const files = new Set(Object.values(manifest.modules).flatMap((m) => m.files));

  it("only lists files present in the manifest", () => {
    for (const file of Object.keys(expectations)) expect(files.has(file), file).toBe(true);
  });

  it("gives every expected failure a one-line reason", () => {
    for (const [file, reason] of Object.entries(expectations)) {
      expect(reason.length, file).toBeGreaterThan(10);
      expect(reason, file).not.toContain("\n");
    }
  });

  it("covers the process-exit, timers and next-tick family", () => {
    for (const m of ["process-exit", "timers", "next-tick"]) {
      expect(manifest.modules[m as keyof typeof manifest.modules].files.length).toBeGreaterThan(0);
    }
  });
});
