import { describe, it, expect } from "vitest";
import { createAsyncHooksShim } from "../src/async_hooks.ts";

describe("node-web-shims: async_hooks", () => {
  it("should match node:async_hooks type shape", () => {
    const shim = createAsyncHooksShim();
    const _nodeAsyncHooks: typeof import("node:async_hooks") = shim;
    expect(_nodeAsyncHooks).toBeDefined();
  });

  it("should export AsyncLocalStorage", () => {
    const shim = createAsyncHooksShim();
    expect(typeof shim.AsyncLocalStorage).toBe("function");
  });

  it("should run a callback within AsyncLocalStorage context", () => {
    const shim = createAsyncHooksShim();
    const als = new shim.AsyncLocalStorage();
    const result = als.run({ id: 1 }, () => als.getStore());
    expect(result).toEqual({ id: 1 });
  });

  it("should export AsyncResource", () => {
    const shim = createAsyncHooksShim();
    expect(typeof shim.AsyncResource).toBe("function");
  });
});
