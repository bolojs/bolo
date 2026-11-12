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

  it("names the thrown error AssertionError, not the inherited Error (unenv patch)", () => {
    let error: InstanceType<typeof assert.AssertionError> | undefined;
    try {
      assert.strictEqual(1, 2);
    } catch (e) {
      error = e as InstanceType<typeof assert.AssertionError>;
    }
    expect(error?.name).toBe("AssertionError");
    expect(error?.stack).toContain("AssertionError");
  });

  it("AssertionError carries code ERR_ASSERTION", () => {
    try {
      assert.deepStrictEqual({ a: 1 }, { a: 2 });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ERR_ASSERTION");
    }
  });

  it("missing arguments throw ERR_MISSING_ARGS coded errors", () => {
    expect(() => assert.deepStrictEqual(1)).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
    expect(() => assert.strictEqual()).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
  });

  it("a non-string/non-Error message throws ERR_INVALID_ARG_TYPE", () => {
    expect(() => assert.deepStrictEqual(1, 2, {} as unknown as string)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("assert.strict is the strict facade", () => {
    expect(typeof assert.strict).toBe("function");
    expect(assert.strict.strict).toBe(assert.strict);
    expect(() => assert.strict.equal("1", 1)).toThrowError(
      expect.objectContaining({ code: "ERR_ASSERTION" }),
    );
    expect(() => assert.strict.deepEqual({ a: 1 }, { a: 2 })).toThrowError(
      expect.objectContaining({ code: "ERR_ASSERTION" }),
    );
  });

  it("rejects/doesNotReject carry Node's validation error codes", async () => {
    // A non-promise, non-function argument → ERR_INVALID_ARG_TYPE.
    await expect(assert.rejects("fail", {})).rejects.toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    // A function that does not return a promise → ERR_INVALID_RETURN_VALUE.
    await expect(
      assert.rejects(
        () => {},
        () => true,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "ERR_INVALID_RETURN_VALUE" }));
    await expect(assert.doesNotReject(123)).rejects.toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    // A rejected promise resolves the assertion (Node's behavior too).
    const boom = new Error("boom");
    await expect(assert.rejects(Promise.reject(boom))).resolves.toBeUndefined();
    // A validator that does not match surfaces the caught error.
    await expect(assert.rejects(Promise.reject(boom), () => "nope")).rejects.toThrowError(
      /validation function is expected to return/,
    );
  });
});
