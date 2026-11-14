import { describe, expect, it } from "vitest";
import { createPerfHooksShim, default as perfHooks } from "./perf_hooks.js";

const shim = createPerfHooksShim();

describe("node:perf_hooks PerformanceObserver", () => {
  it("rejects a non-function callback with ERR_INVALID_ARG_TYPE", () => {
    for (const bad of [1, null, undefined, {}, [], Infinity]) {
      expect(() => new shim.PerformanceObserver(bad as never)).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
      );
    }
  });

  it("rejects a non-object options argument with Node's phrasing", () => {
    const observer = new shim.PerformanceObserver(() => {});
    expect(() => observer.observe(1 as never)).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: 'The "options" argument must be of type object. Received type number (1)',
      }),
    );
    expect(() => observer.observe("test" as never)).toThrowError(
      expect.objectContaining({
        message: "The \"options\" argument must be of type object. Received type string ('test')",
      }),
    );
  });

  it("rejects a non-array entryTypes with ERR_INVALID_ARG_TYPE", () => {
    const observer = new shim.PerformanceObserver(() => {});
    for (const bad of [1, null, {}, Infinity]) {
      expect(() => observer.observe({ entryTypes: bad } as never)).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
      );
    }
  });

  it("requires entryTypes or type, and refuses both together", () => {
    const observer = new shim.PerformanceObserver(() => {});
    expect(() => observer.observe({} as never)).toThrowError(
      expect.objectContaining({ code: "ERR_MISSING_ARGS" }),
    );
    expect(() => observer.observe({ entryTypes: ["mark"], type: "mark" } as never)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });

  it("ignores an unsupported entry type instead of throwing (Node behaviour)", () => {
    const observer = new shim.PerformanceObserver(() => {});
    expect(() => observer.observe({ entryTypes: ["mark", "node"] } as never)).not.toThrow();
    expect(() => observer.observe({ entryTypes: ["bogus"] } as never)).not.toThrow();
    expect(() => observer.observe({ type: "bogus" } as never)).not.toThrow();
  });

  it("exposes Node's supported entry types", () => {
    expect(shim.PerformanceObserver.supportedEntryTypes).toEqual([
      "dns",
      "function",
      "gc",
      "http",
      "http2",
      "mark",
      "measure",
      "net",
      "resource",
    ]);
  });

  it("counts live observers per native observer type in observerCounts", () => {
    const counts = shim.observerCounts as Uint32Array;
    expect(counts.length).toBe(6);
    const before = counts[2];
    const observer = new shim.PerformanceObserver(() => {});
    observer.observe({ type: "http2" });
    expect(counts[2]).toBe(before + 1);
    observer.disconnect();
    expect(counts[2]).toBe(before);
  });

  it("does not count platform-only entry types ('mark')", () => {
    const counts = shim.observerCounts as Uint32Array;
    const before = Array.from(counts);
    const observer = new shim.PerformanceObserver(() => {});
    observer.observe({ entryTypes: ["mark", "measure"] });
    expect(Array.from(counts)).toEqual(before);
    observer.disconnect();
  });

  it("exposes observerCounts under the legacy performanceObserverCounts name too", () => {
    expect(
      (shim as unknown as { performanceObserverCounts: Uint32Array }).performanceObserverCounts,
    ).toBe(shim.observerCounts);
  });

  it("perf_hooks module default exposes the same observer", () => {
    expect(perfHooks.PerformanceObserver).toBe(shim.PerformanceObserver);
  });
});
