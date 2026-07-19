import { describe, it, expect } from "vitest";
import { hintFor, attachHint, enrichMessage, type BoloError } from "./error-hints.js";

describe("error-hints", () => {
  it("returns a hint for known cross-origin Worker failures", () => {
    const hint = hintFor("Failed to construct 'Worker': Script at cross origin");
    expect(hint).toMatch(/__preferLocalBundler/);
  });

  it("returns undefined for unknown messages", () => {
    expect(hintFor("some unrelated error")).toBeUndefined();
  });

  it("attachHint copies all fields and only adds hint when matched", () => {
    const base: BoloError = {
      kind: "transform",
      source: "main",
      message: "Wasm unreachable trap",
      ts: 1,
    };
    const enriched = attachHint(base);
    expect(enriched.hint).toMatch(/__preferLocalBundler/);
    expect(enriched.kind).toBe("transform");
    expect(enriched.message).toBe(base.message);
  });

  it("attachHint returns the same reference shape when no hint matches", () => {
    const base: BoloError = { kind: "network", source: "main", message: "x", ts: 1 };
    const out = attachHint(base);
    expect(out.hint).toBeUndefined();
    expect(out.message).toBe("x");
  });

  it("enrichMessage appends Hint when matched, passes through otherwise", () => {
    const enriched = enrichMessage("ServiceWorker timeout");
    expect(enriched).toMatch(/^ServiceWorker timeout\n\nHint:/);
    expect(enrichMessage("nothing")).toBe("nothing");
  });
});