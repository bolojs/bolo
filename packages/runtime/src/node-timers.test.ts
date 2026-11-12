import { describe, it, expect, vi } from "vitest";
import { createNodeTimers } from "./node-timers.js";
import { createEventLoop } from "./event-loop.js";

const setup = (warn?: (name: string, message: string) => void) => {
  const after = vi.fn();
  const loop = createEventLoop({
    drainTicks: after,
    onUncaught: (e) => {
      throw e;
    },
    isExited: () => false,
  });
  const { timers } = createNodeTimers({
    setTimer: (fn, ms) => loop.setTimeout(fn, ms),
    clearTimer: (h) => loop.clearTimeout(h),
    setImmediate: (fn) => loop.setImmediate(fn),
    clearImmediate: (h) => loop.clearImmediate(h),
    warn,
  });
  // Drive the loop like the worker does; it returns once no ref'd handle remains.
  const run = () => loop.run();
  return { timers, hasRefed: loop.hasRefed, after, run };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createNodeTimers", () => {
  it("does not resurrect cleared timers on refresh", async () => {
    const { timers, run, hasRefed } = setup();
    const fn = vi.fn();
    const timer = timers.setTimeout(fn, 1) as { refresh(): unknown };
    timers.clearTimeout(timer);
    timer.refresh();
    expect(hasRefed()).toBe(false);
    await run();
    expect(fn).not.toHaveBeenCalled();
  });

  it("can cancel another immediate in the active batch", async () => {
    const { timers, run } = setup();
    const fn = vi.fn();
    timers.setImmediate(() => timers.clearImmediate(second));
    const second = timers.setImmediate(fn);
    await run();
    expect(fn).not.toHaveBeenCalled();
  });

  it("binds this to the Timeout and passes args", async () => {
    const { timers, run } = setup();
    const seen: unknown[] = [];
    const t = timers.setTimeout(
      function (this: unknown, ...a: unknown[]) {
        seen.push(this, ...a);
      },
      1,
      "x",
    );
    await run();
    expect(seen).toEqual([t, "x"]);
  });

  it("throws ERR_INVALID_ARG_TYPE for non-function callbacks", () => {
    const { timers, run } = setup();
    for (const f of [timers.setTimeout, timers.setInterval, timers.setImmediate]) {
      expect(() => f("foo" as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
    }
  });

  it("supports numeric/string ids, toPrimitive, close, dispose and _destroyed", async () => {
    const { timers, run } = setup();
    const fn = vi.fn();
    const a = timers.setTimeout(fn, 1) as { [Symbol.toPrimitive](): number; _destroyed: boolean };
    timers.clearTimeout(+(a as never));
    expect(a._destroyed).toBe(true);
    const b = timers.setTimeout(fn, 1) as { [Symbol.dispose](): void };
    timers.clearTimeout(`${b as never}`);
    const c = timers.setTimeout(fn, 1) as { [Symbol.dispose](): void };
    c[Symbol.dispose]();
    await run();
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
    const { timers, run } = setup();
    let calls = 0;
    const t = timers.setTimeout(() => {
      if (++calls === 1) (t as { refresh(): void }).refresh();
    }, 1);
    await run();
    expect(calls).toBe(2);
  });

  it("turns a timeout into an interval by setting _repeat", async () => {
    const { timers, run } = setup();
    let calls = 0;
    const t = timers.setTimeout(() => {
      calls++;
      if ((t as { _repeat: number | null })._repeat) timers.clearInterval(t);
      (t as { _repeat: number | null })._repeat = 1;
    }, 1);
    await run();
    expect(calls).toBe(2);
  });

  it("does not run an unref'd immediate when nothing else is alive", async () => {
    const { timers, run } = setup();
    const fn = vi.fn();
    (timers.setImmediate(fn) as { unref(): void }).unref();
    await run();
    expect(fn).not.toHaveBeenCalled();
    const ran = vi.fn();
    timers.setTimeout(() => {}, 20);
    (timers.setImmediate(ran) as { unref(): void }).unref();
    await run();
    expect(ran).toHaveBeenCalled();
  });

  it("clears an immediate and runs afterCallback", async () => {
    const { timers, after, run } = setup();
    const fn = vi.fn();
    timers.clearImmediate(timers.setImmediate(fn));
    timers.setImmediate(() => {});
    await run();
    expect(fn).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("implements enroll validation and active/unenroll", async () => {
    const { timers, run } = setup();
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
    await run();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const bogus = { _idleTimeout: -1 };
    timers.active(bogus);
    expect(bogus).toEqual({ _idleTimeout: -1 });
    timers.unenroll(item);
    expect(item._idleTimeout).toBe(-1);
  });

  it("survives user-overwritten call/apply and warns on overflow", async () => {
    const warn = vi.fn();
    const { timers, run } = setup(warn);
    const fn = Object.assign(vi.fn(), { call: "x", apply: "y" });
    timers.setImmediate(fn, 1);
    timers.setTimeout(fn, 1);
    await run();
    expect(fn).toHaveBeenCalledTimes(2);
    timers.clearTimeout(timers.setTimeout(() => {}, 2 ** 31));
    expect(warn).toHaveBeenCalledWith(
      "TimeoutOverflowWarning",
      `${2 ** 31} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
    );
  });
});
