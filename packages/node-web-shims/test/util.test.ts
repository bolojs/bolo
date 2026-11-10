import { describe, it, expect } from "vitest";
import { createUtilShim, format, inspect, types } from "../src/util.ts";

describe("node-web-shims: util", () => {
  it("should match node:util type shape", () => {
    const shim = createUtilShim();
    const _nodeUtil: typeof import("node:util") = shim;
    expect(_nodeUtil).toBeDefined();
  });

  it("exposes the full format/inspect/types surface as enumerable keys", () => {
    const shim = createUtilShim();
    for (const name of ["format", "formatWithOptions", "inspect", "types", "promisify", "inherits"]) {
      expect(Object.keys(shim), `missing ${name}`).toContain(name);
    }
  });

  it("format() substitutes specifiers like Node", () => {
    expect(format("%s:%d", "a", 3)).toBe("a:3");
    expect(format("100%%")).toBe("100%");
    expect(format("%j", { a: 1 })).toBe('{"a":1}');
  });

  it("format() tolerates non-string first arguments", () => {
    // unenv's version threw `.replace of undefined` here.
    expect(format({ a: 1 })).toBe("{ a: 1 }");
    expect(format("a", { b: 2 })).toBe("a { b: 2 }");
    expect(format(1, 2, 3)).toBe("1 2 3");
  });

  it("inspect() handles circular structures", () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;
    expect(inspect(obj)).toContain("[Circular *1]");
  });

  it("inspect() formats common values like Node", () => {
    expect(inspect({ a: 1, b: "x" })).toBe("{ a: 1, b: 'x' }");
    expect(inspect([1, "two"])).toBe("[ 1, 'two' ]");
    expect(inspect(undefined)).toBe("undefined");
    expect(inspect(null)).toBe("null");
    expect(inspect(/re/g)).toBe("/re/g");
  });

  it("honours util.inspect.custom", () => {
    const value = {
      [inspect.custom]: () => "custom!",
    };
    expect(inspect(value)).toBe("custom!");
  });

  it("types predicates work", () => {
    expect(types.isDate(new Date())).toBe(true);
    expect(types.isRegExp(/x/)).toBe(true);
    expect(types.isPromise(Promise.resolve())).toBe(true);
    expect(types.isMap(new Map())).toBe(true);
  });
});
