import { describe, expect, it } from "vitest";
import vm from "./vm.js";

describe("node:vm shim", () => {
  it("propagates a throwing toString from the Script constructor (test-vm-script-throw-in-tostring)", () => {
    expect(
      () =>
        new vm.Script({
          toString() {
            throw new Error("boom");
          },
        }),
    ).toThrow(Error);
  });

  it("reflects defineProperty on the context global back onto the sandbox (test-vm-indexed-properties)", () => {
    const sandbox = {} as Record<string | number, unknown>;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(`Object.defineProperty(this, 99, { value: 20, enumerable: true });`, ctx);
    expect(sandbox[99]).toBe(20);
  });

  it("runs delete/defineProperty against the contextified global (test-vm-deleting-property)", () => {
    const context = vm.createContext();
    const res = vm.runInContext(
      `this.x = 'prop'; delete this.x; Object.getOwnPropertyDescriptor(this, 'x');`,
      context,
    );
    expect(res).toBeUndefined();
  });

  it("createContext returns the sandbox itself and isContext recognizes it", () => {
    const sandbox = { a: 1 };
    const ctx = vm.createContext(sandbox);
    expect(ctx).toBe(sandbox);
    expect(vm.isContext(ctx)).toBe(true);
    expect(vm.isContext({})).toBe(false);
  });

  it("global var writes land on the sandbox and builtins resolve", () => {
    const sandbox = {} as Record<string, unknown>;
    const ctx = vm.createContext(sandbox);
    const res = vm.runInContext(`var y = JSON.parse('[1,2]'); y.length;`, ctx);
    expect(res).toBe(2);
    expect(sandbox.y).toEqual([1, 2]);
  });

  it("runInNewContext contextifies a provided sandbox", () => {
    const sandbox = {} as Record<string, unknown>;
    const res = vm.runInNewContext(`this.z = 41 + 1; this.z;`, sandbox);
    expect(res).toBe(42);
    expect(sandbox.z).toBe(42);
  });

  it("runInThisContext evaluates in the realm global scope", () => {
    expect(vm.runInThisContext(`1 + 2`)).toBe(3);
  });

  it("rejects a non-context in runInContext with ERR_INVALID_ARG_TYPE", () => {
    expect(() => vm.runInContext(`1`, {} as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});
