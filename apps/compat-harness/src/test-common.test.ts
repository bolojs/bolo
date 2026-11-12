import { describe, expect, it, vi } from "vitest";
import { internalShimSources } from "./test-common.js";

/**
 * The internal shim sources are vanilla CJS strings executed inside the
 * container by the bundler. Loading them here with `new Function` (the same
 * wrap Node's module system uses) proves they parse as CJS and that the
 * JS-visible semantics match what the vendored Node tests exercise.
 */

interface CjsSandbox {
  exports: Record<string, unknown>;
  processStub: {
    exitCode: number | undefined;
    handlers: Map<string, Array<(...args: unknown[]) => void>>;
    on: (event: string, fn: (...args: unknown[]) => void) => void;
    emit: (event: string) => void;
  };
  consoleStub: { log: (line: string) => void; error: (line: unknown) => void };
  lines: string[];
  errors: unknown[];
}

const loadCjs = (source: string, globals: Record<string, unknown> = {}): CjsSandbox => {
  const module = { exports: {} as Record<string, unknown> };
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const lines: string[] = [];
  const errors: unknown[] = [];
  const sandbox: CjsSandbox = {
    exports: module.exports,
    processStub: {
      exitCode: undefined,
      handlers,
      on: (event, fn) => {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      emit: (event) => {
        for (const fn of handlers.get(event) ?? []) fn();
      },
    },
    consoleStub: {
      log: (line) => lines.push(line),
      error: (err) => errors.push(err),
    },
    lines,
    errors,
  };
  const requireStub = (id: string): unknown => {
    throw new Error(`unexpected require("${id}") in shim sandbox`);
  };
  const baseGlobals: Record<string, unknown> = {
    require: requireStub,
    module,
    exports: module.exports,
    process: sandbox.processStub,
    performance,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    console: sandbox.consoleStub,
    ...globals,
  };
  const names = Object.keys(baseGlobals);
  const fn = new Function(...names, source) as (...args: unknown[]) => void;
  fn(...names.map((name) => baseGlobals[name]));
  sandbox.exports = module.exports;
  return sandbox;
};

describe("internal/test/binding", () => {
  const source = internalShimSources["internal/test/binding"];
  it("exposes a faithful timers.getLibuvNow", () => {
    const { internalBinding } = loadCjs(source).exports as {
      internalBinding: (id: string) => { getLibuvNow: () => number };
    };
    const binding = internalBinding("timers");
    expect(typeof binding.getLibuvNow).toBe("function");
    const first = binding.getLibuvNow();
    expect(first).toBeLessThan(0x3ffffff);
    expect(binding.getLibuvNow()).toBeGreaterThanOrEqual(first);
  });

  it("throws ERR_INVALID_MODULE for unknown and internal_only bindings", () => {
    const { internalBinding } = loadCjs(source).exports as {
      internalBinding: (id: string) => unknown;
    };
    for (const id of ["cares_wrap", "internal_only_foo"]) {
      expect(() => internalBinding(id)).toThrowError(/No such binding/);
      try {
        internalBinding(id);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("ERR_INVALID_MODULE");
      }
    }
  });
});

describe("internal/linkedlist", () => {
  const source = internalShimSources["internal/linkedlist"];
  it("matches Node's append/remove/peek/isEmpty semantics", () => {
    const L = loadCjs(source).exports as {
      init: <T extends object>(list: T) => T;
      peek: (list: Record<string, unknown>) => unknown;
      append: (list: object, item: object) => void;
      remove: (item: object) => void;
      isEmpty: (list: object) => boolean;
    };
    const list = { name: "list" };
    const A = { name: "A" };
    const B = { name: "B" };
    const C = { name: "C" };
    for (const item of [list, A, B, C]) L.init(item);
    expect(L.isEmpty(list)).toBe(true);
    expect(L.peek(list)).toBeNull();

    L.append(list, A);
    L.append(list, B);
    L.append(list, C);
    expect(L.peek(list)).toBe(A);
    expect(L.peek(A)).toBe(B);
    expect(L.peek(B)).toBe(C);
    expect(L.peek(C)).toBe(list);

    L.remove(B);
    L.remove(B); // removing twice must not hurt
    expect(L.peek(A)).toBe(C);

    // append re-orders an already-linked item to the tail
    L.append(list, A);
    expect(L.peek(list)).toBe(C);
    expect(L.peek(C)).toBe(A);
    expect(L.peek(A)).toBe(list);
  });
});

describe("internal/timers", () => {
  const source = internalShimSources["internal/timers"];

  it("setUnrefTimeout rejects non-function callbacks with ERR_INVALID_ARG_TYPE", () => {
    const { setUnrefTimeout } = loadCjs(source).exports as {
      setUnrefTimeout: (cb: unknown, ms?: number) => unknown;
    };
    for (const cb of [null, true, 0, 1, NaN, "", "foo", {}, Symbol()]) {
      expect(() => setUnrefTimeout(cb)).toThrowError(/must be of type function/);
      try {
        setUnrefTimeout(cb);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("ERR_INVALID_ARG_TYPE");
      }
    }
  });

  it("setUnrefTimeout returns the tracked timer, unref'd", () => {
    const unref = vi.fn(function unref(this: { refed: boolean }) {
      this.refed = false;
      return this;
    });
    const fakeTimer = { refed: true, unref };
    const setTimeoutStub = vi.fn(() => fakeTimer);
    const { setUnrefTimeout } = loadCjs(source, { setTimeout: setTimeoutStub }).exports as {
      setUnrefTimeout: (cb: () => void, ms: number, ...args: unknown[]) => unknown;
    };
    const cb = () => {};
    const timer = setUnrefTimeout(cb, 5, "arg");
    expect(setTimeoutStub).toHaveBeenCalledWith(cb, 5, "arg");
    expect(unref).toHaveBeenCalledOnce();
    expect(timer).toBe(fakeTimer);
    expect(fakeTimer.refed).toBe(false);
  });
});

describe("node:test", () => {
  const source = internalShimSources["node:test"];

  it("runs a passing test serially and prints TAP", () => {
    const sandbox = loadCjs(source);
    const { test } = sandbox.exports as { test: (name: string, fn: () => void) => void };
    test("passes", () => {});
    expect(sandbox.lines).toEqual(["ok 1 passes"]);
    sandbox.processStub.emit("exit");
    expect(sandbox.lines).toContain("1..1");
    expect(sandbox.processStub.exitCode).toBeUndefined();
  });

  it("reports failures and forces a non-zero exit code", () => {
    const sandbox = loadCjs(source);
    const { test } = sandbox.exports as { test: (name: string, fn: () => void) => void };
    test("fails", () => {
      throw new Error("boom");
    });
    expect(sandbox.lines).toEqual(["not ok 1 fails"]);
    expect(sandbox.processStub.exitCode).toBe(1);
    sandbox.processStub.emit("exit");
    expect(sandbox.lines.at(-1)).toBe("1..1");
  });

  it("awaits async tests before reporting", async () => {
    const sandbox = loadCjs(source);
    const { test } = sandbox.exports as {
      test: (name: string, fn: () => Promise<void>) => Promise<void> | undefined;
    };
    let settled = false;
    const pending = test("async", async () => {
      await Promise.resolve();
      settled = true;
    });
    expect(settled).toBe(false); // deferred to a microtask
    await pending;
    expect(settled).toBe(true);
    expect(sandbox.lines).toEqual(["ok 1 async"]);
  });

  it("describe groups tests declared inside its body", () => {
    const sandbox = loadCjs(source);
    const { describe, test } = sandbox.exports as {
      describe: (name: string, fn: () => void) => void;
      test: (name: string, fn: () => void) => void;
    };
    describe("suite", () => {
      test("inside", () => {});
    });
    expect(sandbox.lines).toEqual(["ok 1 inside"]);
  });
});
