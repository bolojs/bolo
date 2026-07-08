import { describe, it, expect } from "vitest";
import { createUtilShim } from "../src/util.ts";

describe("node-web-shims: util", () => {
  it("should match node:util type shape", () => {
    const shim = createUtilShim();
    const _nodeUtil: typeof import("node:util") = shim;
    expect(_nodeUtil).toBeDefined();
  });

  it("should export promisify", () => {
    const shim = createUtilShim();
    expect(typeof shim.promisify).toBe("function");
  });

  it("should export inherits", () => {
    const shim = createUtilShim();
    expect(typeof shim.inherits).toBe("function");
  });

  it("should export types", () => {
    const shim = createUtilShim();
    expect(shim.types).toBeDefined();
  });
});
