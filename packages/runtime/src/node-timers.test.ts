import { describe, it, expect, vi } from "vitest";
import { createNodeTimers } from "./node-timers.js";

const setup = () => {
  const after = vi.fn();
  const { timers, hasRefed } = createNodeTimers({
    setNative: (fn, ms) => setTimeout(fn, ms),
    clearNative: (id) => clearTimeout(id as never),
    afterCallback: after,
  });
  return { timers, hasRefed, after };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createNodeTimers", () => {
  it("binds this to the Timeout and passes args", async () => {
    const { timers } = setup();
    const seen: unknown[] = [];
    const t = timers.setTimeout(
      function (this: unknown, ...a: unknown[]) {
        seen.push(this, ...a);
      },
      1,
      "x",
    );
    await wait(10);
    expect(seen).toEqual([t, "x"]);
  });

  it("throws ERR_INVALID_ARG_TYPE for non-function callbacks", () => {
    const { timers } = setup();
    for (const f of [timers.setTimeout, timers.setInterval, timers.setImmediate]) {
      expect(() => f("foo" as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
  });

  it("supports numeric/string ids, toPrimitive, close, dispose and _destroyed", async () => {
    const { timers } = setup();
    const fn = vi.fn();
    const a = timers.setTimeout(fn, 1) as { [Symbol.toPrimitive](): number; _destroyed: boolean };
    timers.clearTimeout(+(a as never));
    expect(a._destroyed).toBe(true);
    const b = timers.setTimeout(fn, 1) as { [Symbol.dispose](): void };
    timers.clearTimeout(`${b as never}`);
    const c = timers.setTimeout(fn, 1) as { [Symbol.dispose](): void };
    c[Symbol.dispose]();
    await wait(10);
    expect(fn).not.toHaveBeenCalled();
  });

  it("tracks refed handles and unref drops liveness", () => {
    const { timers, hasRefed } = setup();
    const t = timers.setTimeout(() => {}, 50) as {
      unref(): unknown;
      ref(): unknown;
      hasRef(): boolean;
    };
    expect(hasRefed()).toBe(true);
    t.unref();
    expect(hasRefed()).toBe(false);
    expect(t.hasRef()).toBe(false);
    timers.clearTimeout(t);
  });

  it("refresh re-arms a timer from inside its callback", async () => {
    const { timers } = setup();
    let calls = 0;
    const t = timers.setTimeout(() => {
      if (++calls === 1) (t as { refresh(): void }).refresh();
    }, 1);
    await wait(30);
    expect(calls).toBe(2);
  });

  it("turns a timeout into an interval by setting _repeat", async () => {
    const { timers } = setup();
    let calls = 0;
    const t = timers.setTimeout(() => {
      calls++;
      if ((t as { _repeat: number | null })._repeat) timers.clearInterval(t);
      (t as { _repeat: number | null })._repeat = 1;
    }, 1);
    await wait(30);
    expect(calls).toBe(2);
  });

  it("does not run an unref'd immediate when nothing else is alive", async () => {
    const { timers } = setup();
    const fn = vi.fn();
    (timers.setImmediate(fn) as { unref(): void }).unref();
    await wait(10);
    expect(fn).not.toHaveBeenCalled();
    const ran = vi.fn();
    const keep = timers.setTimeout(() => {}, 20);
    (timers.setImmediate(ran) as { unref(): void }).unref();
    await wait(10);
    expect(ran).toHaveBeenCalled();
    timers.clearTimeout(keep);
  });

  it("clears an immediate and runs afterCallback", async () => {
    const { timers, after } = setup();
    const fn = vi.fn();
    timers.clearImmediate(timers.setImmediate(fn));
    timers.setImmediate(() => {});
    await wait(10);
    expect(fn).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("implements enroll validation and active/unenroll", async () => {
    const { timers } = setup();
    expect(() => timers.enroll({}, "foo")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => timers.enroll({}, -1)).toThrow(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message:
          'The value of "msecs" is out of range. It must be a non-negative finite number. Received -1',
      }),
    );
    const onTimeout = vi.fn();
    const item: Record<string, unknown> = { _onTimeout: onTimeout };
    timers.enroll(item, 1);
    timers.enroll(item, 5);
    expect(item._idleTimeout).toBe(5);
    timers.active(item);
    expect(Number.isInteger(item._idleStart)).toBe(true);
    await wait(30);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const bogus = { _idleTimeout: -1 };
    timers.active(bogus);
    expect(bogus).toEqual({ _idleTimeout: -1 });
    timers.unenroll(item);
    expect(item._idleTimeout).toBe(-1);
  });

  it("survives user-overwritten call/apply and warns on overflow", async () => {
    const warn = vi.fn();
    const { timers } = createNodeTimers({
      setNative: (fn, ms) => setTimeout(fn, ms),
      clearNative: (id) => clearTimeout(id as never),
      afterCallback: () => {},
      warn,
    });
    const fn = Object.assign(vi.fn(), { call: "x", apply: "y" });
    timers.setImmediate(fn, 1);
    timers.setTimeout(fn, 1);
    await wait(10);
    expect(fn).toHaveBeenCalledTimes(2);
    timers.clearTimeout(timers.setTimeout(() => {}, 2 ** 31));
    expect(warn).toHaveBeenCalledWith(
      "TimeoutOverflowWarning",
      `${2 ** 31} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
    );
  });
});
