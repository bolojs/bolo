import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { markerLines, programArb, renderProgram } from "./process-programs.js";

const runNode = (source: string) => {
  const dir = mkdtempSync(join(tmpdir(), "bolo-diff-"));
  const file = join(dir, "p.js");
  writeFileSync(file, source);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 10_000 });
  return { code: r.status, out: markerLines(r.stdout) };
};

describe("process-program generator", () => {
  // Each property run spawns real Node twice-plus; under parallel CI load the
  // per-case wall time can blow past the vitest 5s default. Give it room.
  it("renders syntactically valid programs that real Node runs to completion", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(programArb, (program) => {
        const r = runNode(renderProgram(program));
        // Valid source never fails to parse (Node reports SyntaxError as exit 1 with no markers
        // and also for throws, so assert the parse separately).
        expect(() => new Function(renderProgram(program))).not.toThrow();
        expect(typeof r.code).toBe("number");
      }),
      { numRuns: 25, seed: 20261109 },
    );
  });

  it("is deterministic under the oracle (two Node runs agree)", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(programArb, (program) => {
        const src = renderProgram(program);
        expect(runNode(src)).toEqual(runNode(src));
      }),
      { numRuns: 15, seed: 20261109 },
    );
  });
});
