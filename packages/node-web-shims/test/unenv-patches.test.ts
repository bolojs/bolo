import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { patchUnenvAssert } from "../src/unenv-patches.ts";

const ORIGINAL = `export class AssertionError extends Error {
	constructor(options) {
		super();
		this.actual = options.actual;
		this.expected = options.expected;
		this.operator = options.operator || "";
	}
}
const inspect = (val, opts) => val;
`;
const id = "/x/node_modules/unenv/dist/runtime/node/assert.mjs";

describe("patchUnenvAssert", () => {
  it("patches the pristine unenv assert module", () => {
    const out = patchUnenvAssert(id, ORIGINAL);
    expect(out).toContain('this.name = "AssertionError"');
    expect(out).toContain("super(message)");
    expect(out).not.toContain("(val, opts) => val");
  });
  it("ignores other modules and already patched code", () => {
    expect(patchUnenvAssert("/x/other.mjs", ORIGINAL)).toBeNull();
    const patched = patchUnenvAssert(id, ORIGINAL) as string;
    expect(patchUnenvAssert(id, patched)).toBeNull();
  });
  it("applies to the installed unenv source (or it already carries the repo patch)", () => {
    const file = createRequire(import.meta.url).resolve("unenv/node/assert");
    const real = readFileSync(file.replace(/assert\.mjs$/, "assert.mjs"), "utf8");
    // Repo has the pnpm patch applied, so the pristine anchors are absent here.
    expect(patchUnenvAssert(file, real)).toBeNull();
  });
});
