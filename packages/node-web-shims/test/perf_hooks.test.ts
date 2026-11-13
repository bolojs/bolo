import { describe, it, expect } from "vitest";
import { createPerfHooksShim, PerformanceObserver } from "../src/perf_hooks.ts";

describe("node-web-shims: perf_hooks", () => {
  it("exposes the Node perf_hooks surface plus a working PerformanceObserver", () => {
    const shim = createPerfHooksShim();
    expect(shim.PerformanceObserver).toBe(PerformanceObserver);
    expect(typeof PerformanceObserver.supportedEntryTypes).not.toBe("undefined");
    expect(PerformanceObserver.supportedEntryTypes).toContain("mark");
    expect(PerformanceObserver.supportedEntryTypes).toContain("measure");
  });

  it("PerformanceObserver validates its callback like Node", () => {
    expect(() => new PerformanceObserver(undefined as never)).toThrowError(
      /The "callback" argument must be of type function/,
    );
    try {
      new PerformanceObserver(undefined as never);
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ERR_INVALID_ARG_TYPE");
    }
  });

  it("observe() requires entryTypes or type", () => {
    const obs = new PerformanceObserver(() => {});
    expect(() => obs.observe({} as never)).toThrowError(/entryTypes.*type|type.*entryTypes/);
    expect(() => obs.observe({ entryTypes: [] } as never)).toThrowError();
    expect(() =>
      obs.observe({ entryTypes: ["not-a-real-entry-type"] } as never),
    ).toThrowError(/invalid/i);
  });

  it("disconnect() and takeRecords() are safe no-ops before observe()", () => {
    const obs = new PerformanceObserver(() => {});
    expect(obs.takeRecords()).toEqual([]);
    expect(() => obs.disconnect()).not.toThrow();
  });
});
