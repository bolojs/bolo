import { describe, it, expect } from "vitest";
import { SourceMapIndex } from "./source-map.js";

/**
 * A hand-written v3 map.
 *
 * `mappings` is `;`-separated per generated line; each segment holds
 * [genCol, sourceIndex, origLine, origCol] as base64 VLQ deltas, with the
 * source/line/column deltas continuing from the previous segment.
 *
 *   line 0 → a.js:0:0
 *   line 1 → (no mapping)
 *   line 2 → b.js:1:2
 *   line 3 → b.js:2:2
 */
const MAP = {
  version: 3,
  sources: ["a.js", "b.js"],
  sourcesContent: ["line0\nline1\n", "other0\nother1\nother2\n"],
  mappings: "AAAA;;ACCE;AACA",
};

describe("runtime: SourceMapIndex", () => {
  it("resolves a generated position to the original source and position", () => {
    const index = new SourceMapIndex(MAP);
    // Generated line 1 (1-based) maps to a.js:0:0.
    const first = index.originalPositionFor(1, 0);
    expect(first).toMatchObject({ sourceIndex: 0, line: 0, column: 0 });
    expect(index.sourceFor(first!.sourceIndex)).toBe("a.js");
  });

  it("takes the mapping at or before the requested column on the same line", () => {
    const index = new SourceMapIndex(MAP);
    // Generated line 3 has one mapping; any column on that line finds it.
    const mapped = index.originalPositionFor(3, 100);
    expect(mapped).toMatchObject({ sourceIndex: 1, line: 1, column: 2 });
    expect(mapped?.content).toContain("other1");
  });

  it("carries sourcesContent for the mapped source", () => {
    const index = new SourceMapIndex(MAP);
    expect(index.originalPositionFor(1, 0)?.content).toBe("line0\nline1\n");
  });

  it("returns undefined for unmapped lines", () => {
    const index = new SourceMapIndex(MAP);
    expect(index.originalPositionFor(2, 0)).toBeUndefined();
    expect(index.originalPositionFor(999, 0)).toBeUndefined();
  });

  it("handles a null sourcesContent entry", () => {
    const index = new SourceMapIndex({
      version: 3,
      sources: ["a.js"],
      sourcesContent: [null],
      mappings: "AAAA",
    });
    expect(index.originalPositionFor(1, 0)?.content).toBeUndefined();
  });
});
