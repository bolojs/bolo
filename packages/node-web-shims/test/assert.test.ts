import { describe, it, expect } from "vitest";
import assert from "../src/assert.ts";

describe("node-web-shims: assert", () => {
  it("should match node:assert type shape", () => {
    const _nodeAssert: typeof import("node:assert") = assert;
    expect(_nodeAssert).toBeDefined();
  });

  it("carries the explicit message through the thrown AssertionError", () => {
    expect(() => assert.strictEqual(1, 2, "one is not two")).toThrowError("one is not two");
  });

  it("generates a diagnostic message when none is given (unenv patch)", () => {
    expect(() => assert.strictEqual(1, 2)).toThrowError(/1.*strictEqual.*2/);
    expect(() => assert.deepStrictEqual({ a: 1 }, { a: 2 })).toThrowError(/deepStrictEqual/);
  });

  it("still exposes actual/expected/operator on the thrown error", () => {
    let error: InstanceType<typeof assert.AssertionError> | undefined;
    try {
      assert.strictEqual(1, 2);
    } catch (e) {
      error = e as InstanceType<typeof assert.AssertionError>;
    }
    expect(error).toBeInstanceOf(assert.AssertionError);
    expect(error?.actual).toBe(1);
    expect(error?.expected).toBe(2);
    expect(error?.operator).toBe("strictEqual");
  });
});
