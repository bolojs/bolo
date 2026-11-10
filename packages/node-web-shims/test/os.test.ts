import { describe, it, expect } from "vitest";
import { createOsShim } from "../src/os.ts";

describe("node-web-shims: os", () => {
  it("should match node:os type shape", () => {
    const shim = createOsShim();
    const _nodeOs: typeof import("node:os") = shim;
    expect(_nodeOs).toBeDefined();
  });

  it("exposes EOL as a configurable property like Node", () => {
    const shim = createOsShim();
    const desc = Object.getOwnPropertyDescriptor(shim, "EOL");
    expect(desc?.configurable).toBe(true);
    // The compat suite redefines EOL on the module object.
    Object.defineProperty(shim, "EOL", { value: "\r\n" });
    expect(shim.EOL).toBe("\r\n");
    Object.defineProperty(shim, "EOL", {
      enumerable: true,
      configurable: true,
      get: () => "\n",
    });
    expect(shim.EOL).toBe("\n");
  });

  it("returns loopback networkInterfaces", () => {
    const shim = createOsShim();
    const interfaces = shim.networkInterfaces();
    expect(interfaces).toBeTypeOf("object");
    expect(Object.keys(interfaces).length).toBeGreaterThan(0);
  });

  it("returns a non-empty cpus() list", () => {
    const shim = createOsShim();
    const cpus = shim.cpus();
    expect(cpus.length).toBeGreaterThan(0);
    expect(cpus[0]).toHaveProperty("times");
  });

  it("returns tmpdir and hostname strings", () => {
    const shim = createOsShim();
    expect(shim.tmpdir()).toBe("/tmp");
    expect(typeof shim.hostname()).toBe("string");
    expect(typeof shim.platform()).toBe("string");
    expect(typeof shim.homedir()).toBe("string");
  });
});
