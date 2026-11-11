import { describe, it, expect, beforeAll } from "vitest";
import { createVmShim, Script, initQuickJS } from "./vm-shim.js";

describe("createVmShim", () => {
  beforeAll(async () => {
    await initQuickJS();
  });
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

  it("throws when the evaluated code throws", () => {
    const vm = createVmShim();
    expect(() => vm.runInNewContext("throw new Error('boom')")).toThrow("boom");
  });

  it("runInContext preserves state across calls", async () => {
    const vm = createVmShim();
    const ctx = await vm.createContext({ a: 0 });
    try {
      await vm.runInContext("a = 5", ctx);
      expect(await vm.runInContext("a", ctx)).toBe(5);
    } finally {
      ctx.dispose();
    }
  });

  it("runInContext isolates state between contexts", async () => {
    const vm = createVmShim();
    const ctx1 = await vm.createContext({ a: 1 });
    const ctx2 = await vm.createContext({ a: 2 });
    try {
      await vm.runInContext("a = 10", ctx1);
      expect(await vm.runInContext("a", ctx1)).toBe(10);
      expect(await vm.runInContext("a", ctx2)).toBe(2);
    } finally {
      ctx1.dispose();
      ctx2.dispose();
    }
  });

  it("times out an infinite loop", () => {
    const vm = createVmShim();
    expect(() => vm.runInNewContext("while(true){}", {}, { timeout: 50 })).toThrow("interrupted");
  });

  it("Script runs twice against different contexts with isolated state", async () => {
    const vm = createVmShim();
    const script = new vm.Script("x = (x || 0) + 1");
    const ctx1 = await vm.createContext({ x: 0 });
    const ctx2 = await vm.createContext({ x: 0 });
    try {
      expect(await script.runInContext(ctx1)).toBe(1);
      expect(await script.runInContext(ctx2)).toBe(1);
      expect(await vm.runInContext("x", ctx1)).toBe(1);
      expect(await vm.runInContext("x", ctx2)).toBe(1);
    } finally {
      ctx1.dispose();
      ctx2.dispose();
    }
  });

  it("Script.runInNewContext creates a fresh context each time", async () => {
    const vm = createVmShim();
    const script = new vm.Script("x = (x || 0) + 1");
    expect(await script.runInNewContext({ x: 0 })).toBe(1);
    expect(await script.runInNewContext({ x: 0 })).toBe(1);
  });

  it("Script can be disposed", () => {
    const script = new Script("1");
    script.dispose();
    expect(script.disposed).toBe(true);
  });

  it("Script.runInContext throws after disposal", async () => {
    const vm = createVmShim();
    const script = new vm.Script("1");
    const ctx = await vm.createContext();
    try {
      script.dispose();
      expect(() => script.runInContext(ctx)).toThrow("Script has been disposed");
    } finally {
      ctx.dispose();
    }
  });

  it("runInNewContext returns synchronously without await", () => {
    const vm = createVmShim();
    const res = vm.runInNewContext('({"foo": ["bar", "baz"]})');
    expect(res).toEqual({ foo: ["bar", "baz"] });
  });

  it("isContext reports context status", () => {
    const vm = createVmShim();
    const ctx = vm.createContext({ a: 1 });
    expect(vm.isContext(ctx)).toBe(true);
    expect(vm.isContext({})).toBe(false);
  });
});
