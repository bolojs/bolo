import { afterEach, describe, expect, it } from "vitest";
import { createV8Shim, default as v8 } from "./v8.js";

describe("node:v8 shim", () => {
  afterEach(() => {
    // The module-scope installer may have defined gc; leave it for other tests.
  });

  it("exposes a callable globalThis.gc (--expose-gc surface)", () => {
    expect(typeof globalThis.gc).toBe("function");
    expect(() => (globalThis.gc as () => void)()).not.toThrow();
  });

  it("createV8Shim keeps serialize/deserialize round-trips", () => {
    const shim = createV8Shim();
    const value = { a: [1, 2, 3], b: "text" };
    expect(shim.deserialize(shim.serialize(value))).toEqual(value);
    expect(v8.serialize).toBeDefined();
  });
});
