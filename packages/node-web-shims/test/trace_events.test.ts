import { describe, it, expect } from "vitest";
import {
  createTracing,
  getEnabledCategories,
  createTraceEventsShim,
  Tracing,
} from "../src/trace_events.ts";

const customInspect = Symbol.for("nodejs.util.inspect.custom");

const catchError = (fn: () => void): Error & { code?: string } => {
  try {
    fn();
  } catch (er) {
    return er as Error & { code?: string };
  }
  throw new Error("expected function to throw");
};

describe("node-web-shims: trace_events", () => {
  it("should match node:trace_events type shape", () => {
    const shim = createTraceEventsShim();
    const _nodeTraceEvents: typeof import("node:trace_events") =
      shim as unknown as typeof import("node:trace_events");
    expect(_nodeTraceEvents).toBeDefined();
  });

  it("should validate options like Node", () => {
    const missing = catchError(() => createTracing(undefined as never));
    expect(missing.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(missing.message).toBe(
      'The "options" argument must be of type object. Received undefined',
    );

    const nullOptions = catchError(() => createTracing(null as never));
    expect(nullOptions.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(nullOptions.message).toBe(
      'The "options" argument must be of type object. Received null',
    );

    const stringOptions = catchError(() => createTracing("x" as never));
    expect(stringOptions.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(stringOptions.message).toBe(
      `The "options" argument must be of type object. Received type string ('x')`,
    );

    const missingCategories = catchError(() => createTracing({} as never));
    expect(missingCategories.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(missingCategories.message).toBe(
      'The "options.categories" property must be an instance of Array. Received undefined',
    );

    const stringCategories = catchError(() => createTracing({ categories: "x" } as never));
    expect(stringCategories.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(stringCategories.message).toBe(
      `The "options.categories" property must be an instance of Array. Received type string ('x')`,
    );

    const badElement = catchError(() => createTracing({ categories: [1] } as never));
    expect(badElement.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(badElement.message).toBe(
      'The "options.categories[0]" property must be of type string. Received type number (1)',
    );

    const empty = catchError(() => createTracing({ categories: [] }));
    expect(empty.code).toBe("ERR_TRACE_EVENTS_CATEGORY_REQUIRED");
    expect(empty.message).toBe("At least one category is required");
  });

  it("should create a disabled Tracing object with comma-joined categories", () => {
    const tracing = createTracing({ categories: ["node", "v8"] });
    expect(tracing).toBeInstanceOf(Tracing);
    expect(tracing.enabled).toBe(false);
    expect(tracing.categories).toBe("node,v8");
  });

  it("should flip enabled via enable()/disable() and track enabled categories", () => {
    const t1 = createTracing({ categories: ["node", "v8"] });
    const t2 = createTracing({ categories: ["node.perf", "node"] });

    expect(getEnabledCategories()).toBeUndefined();

    t1.enable();
    expect(t1.enabled).toBe(true);
    expect(getEnabledCategories()).toBe("node,v8");

    t2.enable();
    expect(getEnabledCategories()).toBe("node,node.perf,v8");

    // enable() is idempotent.
    expect(t2.enable()).toBe(true);
    expect(t2.enabled).toBe(true);

    t2.disable();
    expect(t2.enabled).toBe(false);
    expect(getEnabledCategories()).toBe("node,v8");

    t1.disable();
    expect(getEnabledCategories()).toBeUndefined();
  });

  it("destroy() should disable and make later enable() a no-op returning false", () => {
    const tracing = createTracing({ categories: ["foo"] });
    tracing.enable();
    expect(tracing.enabled).toBe(true);

    tracing.destroy();
    expect(tracing.enabled).toBe(false);
    expect(getEnabledCategories()).toBeUndefined();
    expect(tracing.enable()).toBe(false);
    expect(tracing.enabled).toBe(false);
  });

  // Mirrors the trace_events usage in test-util-inspect.js.
  it("should render like Node's util.inspect custom inspection", () => {
    const trace = createTracing({ categories: ["fo"] });
    const inspect = (tracing: Tracing, depth: number): unknown =>
      (tracing as unknown as Record<symbol, (d: number) => unknown>)[customInspect](depth);

    // depth < 0 returns the object itself, which inspects as `Tracing {}`.
    expect(inspect(trace, -1)).toBe(trace);
    expect(inspect(trace, 1)).toBe("Tracing { enabled: false, categories: 'fo' }");

    trace.enable();
    expect(inspect(trace, 1)).toBe("Tracing { enabled: true, categories: 'fo' }");
    trace.disable();
  });
});
