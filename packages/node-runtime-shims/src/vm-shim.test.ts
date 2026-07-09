import { describe, it, expect } from "vitest";
import { createVmShim } from "./vm-shim.js";

describe("createVmShim", () => {
  it("runInNewContext evaluates code and returns the result", async () => {
    const vm = createVmShim();
    expect(await vm.runInNewContext("1 + 2")).toBe(3);
  });

  it("runInNewContext injects context globals", async () => {
    const vm = createVmShim();
    expect(await vm.runInNewContext("a + 5", { a: 10 })).toBe(15);
  });

  it("runInThisContext evaluates without a new context object", async () => {
    const vm = createVmShim();
    expect(await vm.runInThisContext("'ok'")).toBe("ok");
  });

  it("throws when the evaluated code throws", async () => {
    const vm = createVmShim();
    await expect(vm.runInNewContext("throw new Error('boom')")).rejects.toThrow("boom");
  });
});
