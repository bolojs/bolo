import { describe, it, expect } from "vitest";
import { createQuerystringShim } from "../src/querystring.ts";

describe("node-web-shims: querystring", () => {
  it("should match node:querystring type shape", () => {
    const shim = createQuerystringShim();
    const _nodeQuerystring: typeof import("node:querystring") = shim;
    expect(_nodeQuerystring).toBeDefined();
  });

  it("should parse a query string", () => {
    const shim = createQuerystringShim();
    expect(shim.parse("foo=bar&baz=qux")).toEqual({ foo: "bar", baz: "qux" });
  });

  it("should stringify an object", () => {
    const shim = createQuerystringShim();
    expect(shim.stringify({ foo: "bar", baz: "qux" })).toBe("foo=bar&baz=qux");
  });

  it("should escape and unescape", () => {
    const shim = createQuerystringShim();
    expect(shim.escape("a b")).toBe("a%20b");
    expect(shim.unescape("a%20b")).toBe("a b");
  });
});
