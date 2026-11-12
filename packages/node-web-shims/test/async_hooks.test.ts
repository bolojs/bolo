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

  it("restores nested contexts after throws and captures independent callbacks", () => {
    const { AsyncLocalStorage } = createAsyncHooksShim();
    const als = new AsyncLocalStorage();
    const callbacks: Array<() => unknown> = [];
    als.run("outer", () => {
      expect(() =>
        als.run("inner", () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(als.getStore()).toBe("outer");
      callbacks.push(AsyncLocalStorage.bind(() => als.getStore()));
    });
    als.run("other", () => callbacks.push(AsyncLocalStorage.bind(() => als.getStore())));
    expect(callbacks.map((fn) => fn())).toEqual(["outer", "other"]);
    expect(als.getStore()).toBeUndefined();
    als.disable();
    expect(callbacks[0]()).toBeUndefined();
  });

  it("validates every supplied hook callback", () => {
    const { createHook } = createAsyncHooksShim();
    for (const name of ["init", "before", "after", "destroy", "promiseResolve"]) {
      for (const value of [null, 1, {}, []]) {
        expect(() => createHook({ [name]: value })).toThrow(
          expect.objectContaining({
            name: "TypeError",
            code: "ERR_ASYNC_CALLBACK",
            message: `hook.${name} must be a function`,
          }),
        );
      }
    }
  });

  it("should export AsyncResource", () => {
    const shim = createAsyncHooksShim();
    expect(typeof shim.AsyncResource).toBe("function");
  });
});

describe("async_hooks: createHook fires around async boundaries", () => {
  it("fires init/before/after/destroy around a bound callback", async () => {
    const { createHook } = createAsyncHooksShim();
    const mod = await import("../src/async_hooks.ts");
    const events: string[] = [];
    createHook({
      init: (id, type) => events.push(`init:${type}`),
      before: (id) => events.push(`before:${id}`),
      after: (id) => events.push(`after:${id}`),
      destroy: (id) => events.push(`destroy:${id}`),
    }).enable();
    await new Promise<void>((resolve) => {
      const fn = mod.bindAsyncCallback(() => resolve(), "custom");
      fn();
    });
    expect(events).toContain("init:custom");
    expect(events.some((e) => e.startsWith("before:"))).toBe(true);
    expect(events.some((e) => e.startsWith("after:"))).toBe(true);
    expect(events.some((e) => e.startsWith("destroy:"))).toBe(true);
  });
});
