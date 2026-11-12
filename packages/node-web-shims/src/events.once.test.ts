import { EventEmitter } from "unenv/node/events";
import { describe, expect, it } from "vitest";
import { once } from "./events.js";

describe("events.once", () => {
  it("resolves with an array of emitted args", async () => {
    const ee = new EventEmitter();
    process.nextTick(() => ee.emit("myevent", 42, 24));
    await expect(once(ee, "myevent")).resolves.toEqual([42, 24]);
    expect(ee.listenerCount("myevent")).toBe(0);
    expect(ee.listenerCount("error")).toBe(0);
  });

  it("rejects on error emission and detaches both listeners", async () => {
    const ee = new EventEmitter();
    const expected = new Error("kaboom");
    process.nextTick(() => ee.emit("error", expected));
    await expect(once(ee, "myevent")).rejects.toBe(expected);
    expect(ee.listenerCount("error")).toBe(0);
    expect(ee.listenerCount("myevent")).toBe(0);
  });

  it("resolves when listening to the error event itself", async () => {
    const ee = new EventEmitter();
    const expected = new Error("kaboom");
    const promise = once(ee, "error");
    expect(ee.listenerCount("error")).toBe(1);
    process.nextTick(() => ee.emit("error", expected));
    await expect(promise).resolves.toEqual([expected]);
    expect(ee.listenerCount("error")).toBe(0);
  });

  it.each([1, "hi", null, false, () => {}, Symbol(), 1n])(
    "rejects invalid options %s with ERR_INVALID_ARG_TYPE",
    async (options) => {
      const ee = new EventEmitter();
      await expect(once(ee, "myevent", options as never)).rejects.toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    },
  );

  it.each([1, {}, "hi", null, false])(
    "rejects invalid signal %s with ERR_INVALID_ARG_TYPE",
    async (signal) => {
      const ee = new EventEmitter();
      await expect(once(ee, "myevent", { signal } as never)).rejects.toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    },
  );

  it("rejects with AbortError for an already-aborted signal", async () => {
    const ee = new EventEmitter();
    await expect(once(ee, "foo", { signal: AbortSignal.abort() })).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("rejects with AbortError when the signal aborts after listening", async () => {
    const ee = new EventEmitter();
    const ac = new AbortController();
    const promise = once(ee, "foo", { signal: ac.signal });
    process.nextTick(() => ac.abort());
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(ee.listenerCount("foo")).toBe(0);
    expect(ee.listenerCount("error")).toBe(0);
  });

  it("still rejects on abort when a prior abort listener stops propagation", async () => {
    const ee = new EventEmitter();
    const ac = new AbortController();
    const { signal } = ac;
    signal.addEventListener("abort", (e) => e.stopImmediatePropagation(), { once: true });
    const promise = once(ee, "foo", { signal });
    process.nextTick(() => ac.abort());
    await expect(promise).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("works with EventTargets, resolving with the event", async () => {
    const et = new EventTarget();
    const event = new Event("myevent");
    process.nextTick(() => et.dispatchEvent(event));
    await expect(once(et, "myevent")).resolves.toEqual([event]);
  });

  it("resolves (not rejects) for error events on EventTargets", async () => {
    const et = new EventTarget();
    const error = new Event("error");
    process.nextTick(() => et.dispatchEvent(error));
    await expect(once(et, "error")).resolves.toEqual([error]);
  });

  it("rejects invalid emitters with ERR_INVALID_ARG_TYPE", async () => {
    await expect(once(new AbortController() as never, "myevent")).rejects.toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("prioritizes the EventEmitter path even when addEventListener is poisoned", async () => {
    const ee = new EventEmitter();
    (ee as unknown as { addEventListener: unknown }).addEventListener = () => {
      throw new Error("must not be called");
    };
    process.nextTick(() => ee.emit("foo"));
    await once(ee, "foo");
  });
});
