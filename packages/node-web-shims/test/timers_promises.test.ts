import { describe, expect, it } from "vitest";
import { createTimersPromisesShim } from "../src/timers_promises.js";

const createHost = () => {
  const timers: Array<{ fn: () => void; delay: number; cleared: boolean }> = [];
  const immediates: Array<{ fn: () => void; cleared: boolean }> = [];
  return {
    timers,
    immediates,
    host: {
      setTimeout: (fn: () => void, delay = 0) => {
        const rec = { fn, delay, cleared: false };
        timers.push(rec);
        return rec;
      },
      clearTimeout: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      setInterval: (fn: () => void, delay = 0) => {
        const rec = { fn, delay, cleared: false };
        timers.push(rec);
        return rec;
      },
      clearInterval: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
      setImmediate: (fn: () => void) => {
        const rec = { fn, cleared: false };
        immediates.push(rec);
        return rec;
      },
      clearImmediate: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  };
};

describe("timers/promises validation", () => {
  it("rejects a non-object options argument with ERR_INVALID_ARG_TYPE", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    await expect(shim.setTimeout(1, null, 1 as never)).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
  });

  it("rejects a null or malformed signal", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    await expect(shim.setTimeout(1, null, { signal: null as never })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    await expect(shim.setTimeout(1, null, { signal: {} as never })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
    await expect(shim.setImmediate(undefined, { signal: null as never })).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_TYPE",
    });
  });

  it("rejects a non-boolean ref option", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    for (const ref of [1, "", Infinity, null, {}]) {
      await expect(shim.setTimeout(1, null, { ref: ref as never })).rejects.toMatchObject({
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
  });

  it("stringifies coded errors Node-style", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    const err = await shim.setTimeout(1, null, 1 as never).catch((e: unknown) => e);
    expect(String(err)).toContain("ERR_INVALID_ARG_TYPE");
    expect((err as Error).name).toBe("TypeError");
    expect((err as { code?: string }).code).toBe("ERR_INVALID_ARG_TYPE");
  });

  it("accepts an EventTarget-like signal and rejects on abort", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    const controller = new AbortController();
    const promise = shim.setTimeout(10, undefined, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const { host } = createHost();
    const shim = createTimersPromisesShim(host);
    await expect(
      shim.setTimeout(10, undefined, { signal: AbortSignal.abort("boom") }),
    ).rejects.toMatchObject({ cause: "boom" });
  });
});
