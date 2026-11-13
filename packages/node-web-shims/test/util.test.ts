import { describe, it, expect } from "vitest";
import { createUtilShim, format, formatWithOptions, inspect, types } from "../src/util.ts";

describe("node-web-shims: util", () => {
  it("should match node:util type shape", () => {
    const shim = createUtilShim();
    const _nodeUtil: typeof import("node:util") = shim;
    expect(_nodeUtil).toBeDefined();
  });

  it("exposes the full format/inspect/types surface as enumerable keys", () => {
    const shim = createUtilShim();
    for (const name of [
      "format",
      "formatWithOptions",
      "inspect",
      "types",
      "promisify",
      "inherits",
    ]) {
      expect(Object.keys(shim), `missing ${name}`).toContain(name);
    }
  });

  it("format() substitutes specifiers like Node", () => {
    expect(format("%s:%d", "a", 3)).toBe("a:3");
    expect(format("100%%")).toBe("100%");
    expect(format("%j", { a: 1 })).toBe('{"a":1}');
  });

  it("format() renders negative zero as '-0' in every numeric conversion", () => {
    expect(format("%d", -0)).toBe("-0");
    expect(format("%d", " -0.000")).toBe("-0");
    expect(format("%i", -0.5)).toBe("-0");
    expect(format("%f", "-0.0")).toBe("-0");
    expect(format("%s", -0)).toBe("-0");
    expect(format(1, -0)).toBe("1 -0");
    expect(inspect(-0)).toBe("-0");
  });

  it("format() handles Symbol and BigInt args like Node (test-util-format)", () => {
    // Node converts symbols to 'NaN' under numeric specifiers instead of
    // throwing "Cannot convert a Symbol value to a number".
    expect(format("%d", Symbol("x"))).toBe("NaN");
    expect(format("%i", Symbol("x"))).toBe("NaN");
    expect(format("%f", Symbol("x"))).toBe("NaN");
    expect(format("%s", Symbol("x"))).toBe("Symbol(x)");
    // BigInt keeps its 'n' suffix for %d/%i and stays decimal for %f.
    expect(format("%d", 42n)).toBe("42n");
    expect(format("%i", 42n)).toBe("42n");
    // %i uses parseInt semantics — partial numeric strings still parse.
    expect(format("%i", "42.9")).toBe("42");
    expect(format("%i", "abc")).toBe("NaN");
  });

  it("format() inspects objects for %s and reports %j cycles like Node", () => {
    expect(format("%s", { a: 1 })).toBe("{ a: 1 }");
    expect(format("%s", [1, 2])).toBe("[ 1, 2 ]");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(format("%j", circular)).toBe("[Circular: ~]");
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
    // Node prints an empty array as "[]", not "[  ]".
    expect(inspect([])).toBe("[]");
    expect(format([])).toBe("[]");
    expect(format([0])).toBe("[ 0 ]");
    expect(format({})).toBe("{}");
    expect(inspect(undefined)).toBe("undefined");
    expect(inspect(null)).toBe("null");
    expect(inspect(/re/g)).toBe("/re/g");
  });

  it("numericSeparator groups digits like Node ≥21 (test-util-format)", () => {
    expect(inspect(1234567, { numericSeparator: true })).toBe("1_234_567");
    expect(inspect(-1234567, { numericSeparator: true })).toBe("-1_234_567");
    expect(inspect(1234.12345, { numericSeparator: true })).toBe("1_234.123_45");
    expect(inspect(12345678901234567890n, { numericSeparator: true })).toBe(
      "12_345_678_901_234_567_890n",
    );
    // Exponent, NaN and Infinity forms are left untouched.
    expect(inspect(1e21, { numericSeparator: true })).toBe("1e+21");
    expect(inspect(NaN, { numericSeparator: true })).toBe("NaN");
    expect(inspect(Infinity, { numericSeparator: true })).toBe("Infinity");
    // Default stays unseparated.
    expect(inspect(1234567)).toBe("1234567");
    expect(
      formatWithOptions({ numericSeparator: true }, "%d", 118059162071741140000),
    ).toBe("118_059_162_071_741_140_000");
    expect(formatWithOptions({ numericSeparator: true }, "%i", 1234567)).toBe("1_234_567");
    expect(formatWithOptions({ numericSeparator: true }, "%f", 1234.5)).toBe("1_234.5");
    expect(format("%d", 1234567)).toBe("1234567");
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
