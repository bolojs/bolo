import { describe, it, expect, afterEach, vi } from "vitest";
import {
  create,
  createDomain,
  createDomainShim,
  Domain,
  active,
  _stack,
} from "../src/domain.ts";
import { EventEmitter } from "../src/events.ts";

const proc = globalThis.process as { domain?: unknown; nextTick?: unknown };

// The domain stack and `process.domain` are module-global; reset them so
// tests do not leak state into each other.
afterEach(() => {
  _stack.length = 0;
  delete proc.domain;
});

describe("node-web-shims: domain", () => {
  it("should match node:domain type shape", () => {
    const shim = createDomainShim();
    const _nodeDomain: typeof import("node:domain") = shim as unknown as typeof import("node:domain");
    expect(_nodeDomain).toBeDefined();
  });

  it("should expose create/createDomain/Domain/active/_stack", () => {
    expect(typeof create).toBe("function");
    expect(create).toBe(createDomain);
    expect(create()).toBeInstanceOf(Domain);
    expect(create()).toBeInstanceOf(EventEmitter);
    expect(active).toBeNull();
    expect(Array.isArray(_stack)).toBe(true);
  });

  // Mirrors test-next-tick-domain.js: importing domain must not patch nextTick.
  it("should not replace process.nextTick on import", async () => {
    const origNextTick = proc.nextTick;
    await import("../src/domain.ts");
    expect(proc.nextTick).toBe(origNextTick);
  });

  it("should run a function inside the domain and restore the prior domain", () => {
    const d = create();
    let inside: unknown;
    let thisArg: unknown;
    const ret = d.run(function (this: unknown, a: number, b: number) {
      inside = active;
      thisArg = this;
      return a + b;
    }, 1, 2);

    expect(ret).toBe(3);
    expect(inside).toBe(d);
    expect(thisArg).toBe(d);
    expect(active).toBeUndefined();
    expect(_stack).toHaveLength(0);
  });

  it("should restore the previous domain when nesting runs", () => {
    const d1 = create();
    const d2 = create();
    const seen: unknown[] = [];
    d1.run(() => {
      seen.push(active);
      d2.run(() => {
        seen.push(active);
      });
      seen.push(active);
      seen.push(proc.domain);
    });
    expect(seen).toEqual([d1, d2, d1, d1]);
    expect(active).toBeUndefined();
  });

  // Mirrors test-timers-reset-process-domain-on-throw.js (minus the timer
  // part, which belongs to the timers shim): the 'error' handler observes
  // `process.domain === undefined` and the error carries `.domain === d`.
  it("should route errors thrown in run() to the domain 'error' event, outside its context", () => {
    const d = create();
    const seen: { errDomain?: unknown; procDomain?: unknown; thrown?: boolean } = {};
    d.on("error", (er: Error & { domain?: unknown; domainThrown?: boolean }) => {
      seen.errDomain = er.domain;
      seen.procDomain = proc.domain;
      seen.thrown = er.domainThrown;
    });

    const boom = new Error("boom");
    d.run(() => {
      throw boom;
    });

    expect(seen.errDomain).toBe(d);
    expect(seen.procDomain).toBeUndefined();
    expect(seen.thrown).toBe(true);
    expect(active).toBeNull();
    expect(proc.domain).toBeNull();
  });

  it("should rethrow errors from run() when the domain has no 'error' listener", () => {
    const d = create();
    const boom = new Error("boom");
    expect(() =>
      d.run(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it("should track members and route their error events to the domain", () => {
    const d = create();
    const ee = new EventEmitter();
    d.add(ee);

    expect(d.members).toContain(ee);
    expect((ee as { domain?: unknown }).domain).toBe(d);

    const seen: { err?: unknown; emitter?: unknown; thrown?: boolean; procDomain?: unknown } = {};
    d.on("error", (er: Error & { domain?: unknown; domainEmitter?: unknown; domainThrown?: boolean }) => {
      seen.err = er.domain;
      seen.emitter = er.domainEmitter;
      seen.thrown = er.domainThrown;
      seen.procDomain = proc.domain;
    });

    const ret = ee.emit("error", new Error("boom"));
    expect(ret).toBe(false);
    expect(seen.err).toBe(d);
    expect(seen.emitter).toBe(ee);
    expect(seen.thrown).toBe(false);
    expect(seen.procDomain).toBeNull();

    d.remove(ee);
    expect((ee as { domain?: unknown }).domain).toBeNull();
    expect(d.members).not.toContain(ee);
    // After removal, unhandled 'error' events throw again.
    expect(() => ee.emit("error", new Error("unhandled"))).toThrow("unhandled");
  });

  it("should not route error events when the emitter has its own 'error' listener", () => {
    const d = create();
    const ee = new EventEmitter();
    d.add(ee);
    const onDomain = vi.fn();
    d.on("error", onDomain);
    const onEmitter = vi.fn();
    ee.on("error", onEmitter);

    const er = new Error("boom");
    expect(ee.emit("error", er)).toBe(true);
    expect(onEmitter).toHaveBeenCalledWith(er);
    expect(onDomain).not.toHaveBeenCalled();
  });

  it("should move an emitter between domains on add", () => {
    const d1 = create();
    const d2 = create();
    const ee = new EventEmitter();
    d1.add(ee);
    d2.add(ee);
    expect((ee as { domain?: unknown }).domain).toBe(d2);
    expect(d1.members).not.toContain(ee);
    expect(d2.members).toContain(ee);
  });

  it("should bind callbacks: run them in the domain and catch their errors", () => {
    const d = create();
    const seen: unknown[] = [];
    d.on("error", (er: Error & { domain?: unknown }) => {
      seen.push(er.domain, proc.domain);
    });

    const bound = d.bind((a: number, b: number) => a + b);
    expect((bound as unknown as { domain?: unknown }).domain).toBe(d);
    expect(bound(2, 3)).toBe(5);
    expect(active).toBeUndefined();

    const throwing = d.bind(() => {
      throw new Error("bound");
    });
    throwing();
    expect(seen[0]).toBe(d);
    expect(seen[1]).toBeUndefined();
    expect(active).toBeNull();
  });

  it("should intercept Error first arguments with intercept()", () => {
    const d = create();
    const seen: { domain?: unknown; bound?: unknown; thrown?: boolean } = {};
    d.on("error", (er: Error & { domain?: unknown; domainBound?: unknown; domainThrown?: boolean }) => {
      seen.domain = er.domain;
      seen.bound = er.domainBound;
      seen.thrown = er.domainThrown;
    });

    const cb = (_data: string) => {
      throw new Error("should not run");
    };
    const intercepted = d.intercept(cb);
    const er = new Error("io");
    intercepted(er);
    expect(seen.domain).toBe(d);
    expect(seen.bound).toBe(cb);
    expect(seen.thrown).toBe(false);

    const ok = d.intercept((a: number, b: number) => a + b);
    expect(ok(null, 1, 2)).toBe(3);
  });

  it("should support manual enter()/exit()", () => {
    const d = create();
    d.enter();
    expect(active).toBe(d);
    expect(proc.domain).toBe(d);
    expect(_stack).toEqual([d]);
    d.exit();
    expect(active).toBeUndefined();
    expect(_stack).toHaveLength(0);
    // Exiting a domain that is not on the stack is a no-op.
    d.exit();
    expect(active).toBeUndefined();
  });
});
