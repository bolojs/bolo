import { describe, it, expect, vi } from "vitest";

/**
 * The shim reads the caller's source to report the falsy expression, the way
 * Node's `getErrMessage` does. In a browser there is no filesystem, so the
 * host installs a reader; these tests drive that seam with a fake reader.
 *
 * Node caches the derived message per call site (`filename` + position), and
 * the cache lives in the module — so every case imports a fresh module
 * instance, otherwise the first case's message would answer all of them.
 */
const freshAssert = async () => {
  vi.resetModules();
  const [assertModule, okExpression] = await Promise.all([
    import("../src/assert.ts"),
    import("../src/util/ok-expression.ts"),
  ]);
  return {
    assert: assertModule.default,
    setOkExpressionCallSiteReader: okExpression.setOkExpressionCallSiteReader,
    setOkExpressionSourceReader: okExpression.setOkExpressionSourceReader,
  };
};

describe("node-web-shims: assert.ok falsy expression", () => {
  it("reports the caller's expression through the call-site reader", async () => {
    const { assert, setOkExpressionCallSiteReader } = await freshAssert();
    const source = ["assert.ok(false);", ""].join("\n");
    setOkExpressionCallSiteReader(() => ({ source, line: 0, column: 0 }));

    expect(() => assert.ok(false)).toThrowError(
      "The expression evaluated to a falsy value:\n\n  assert.ok(false)\n",
    );
  });

  it("re-maps the position the reader reports", async () => {
    const { assert, setOkExpressionCallSiteReader } = await freshAssert();
    // The reader resolves the call site to another file/position (a bundled
    // program maps back to its original module through a source map).
    const source = ["const x = 1;", "assert.ok(x === 2);", ""].join("\n");
    setOkExpressionCallSiteReader(() => ({ source, line: 1, column: 0 }));

    expect(() => assert.ok(false)).toThrowError(
      "The expression evaluated to a falsy value:\n\n  assert.ok(x === 2)\n",
    );
  });

  it("falls back to the generic message when the reader has no source", async () => {
    const { assert, setOkExpressionCallSiteReader } = await freshAssert();
    setOkExpressionCallSiteReader(() => undefined);

    expect(() => assert.ok(false)).toThrowError("false == true");
  });

  it("still uses the filename reader when no call-site reader is installed", async () => {
    const { assert, setOkExpressionSourceReader } = await freshAssert();
    const seen: string[] = [];
    setOkExpressionSourceReader((filename) => {
      seen.push(filename);
      return undefined;
    });

    expect(() => assert.ok(false)).toThrowError("false == true");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("prefers the call-site reader over the filename reader", async () => {
    const { assert, setOkExpressionCallSiteReader, setOkExpressionSourceReader } =
      await freshAssert();
    const source = ["assert.ok(false);", ""].join("\n");
    let filenameReaderCalled = false;
    setOkExpressionSourceReader(() => {
      filenameReaderCalled = true;
      return "assert.ok(never);\n";
    });
    setOkExpressionCallSiteReader(() => ({ source, line: 0, column: 0 }));

    expect(() => assert.ok(false)).toThrowError(
      "The expression evaluated to a falsy value:\n\n  assert.ok(false)\n",
    );
    expect(filenameReaderCalled).toBe(false);
  });

  it("keeps the explicit message and the no-value message", async () => {
    const { assert, setOkExpressionCallSiteReader } = await freshAssert();
    setOkExpressionCallSiteReader(() => undefined);
    expect(() => assert.ok(false, "custom")).toThrowError("custom");
    expect(() => assert.ok()).toThrowError("No value argument passed to `assert.ok()`");
  });
});
