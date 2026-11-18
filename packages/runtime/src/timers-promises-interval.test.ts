import { describe, expect, it } from "vitest";
import { createEventLoop } from "./event-loop.js";
import { createNodeTimers } from "./node-timers.js";

/**
 * Regression test for the vendored Node test
 * `test/parallel/test-timers-interval-promisified.js`, whose assertion
 * "iterations was 2 < 3" caught the interval generator dropping the ticks
 * that land while the consumer awaits its own work.
 */
describe("timers/promises setInterval under the container event loop", () => {
  it("keeps ticking while the consumer awaits its own work", async () => {
    const loop = createEventLoop({
      drainTicks: () => {},
      onUncaught: (e) => {
        throw e;
      },
      isExited: () => false,
    });
    const { promises } = createNodeTimers({
      setTimer: (fn, ms) => loop.setTimeout(fn, ms),
      clearTimer: (h) => loop.clearTimeout(h),
      setImmediate: (fn) => loop.setImmediate(fn),
      clearImmediate: (h) => loop.clearImmediate(h),
    });

    const controller = new AbortController();
    const { signal } = controller;
    const delay = 10;
    let totalIterations = 0;

    const consumer = (async () => {
      let iteration = 0;
      for await (const _ of promises.setInterval(delay, "foobar", { signal })) {
        iteration++;
        totalIterations = iteration;
        // The consumer's own pending work: 4 interval periods, exactly like
        // the vendored Node test. Ticks keep landing while we wait.
        await new Promise((r) => setTimeout(r, delay * 4));
        if (iteration === 2) controller.abort();
        if (iteration > 2) expect(signal.aborted).toBe(true);
      }
    })();

    const loopRun = loop.run();
    await expect(consumer).rejects.toThrow(/abort/i);
    void loopRun;

    // Node's assertion: the interval must have ticked at least three times
    // by the time the abort landed — i.e. the tick queued *during* iteration
    // 2 (while the consumer was awaiting) is delivered after the abort.
    expect(totalIterations).toBeGreaterThanOrEqual(3);
  });
});
