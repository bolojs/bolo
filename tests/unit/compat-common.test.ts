import { describe, it, expect } from "vitest";
import { createProcessShim, ProcessExit } from "@bolojs/node-runtime-shims";
import { commonIndexSource } from "../../apps/compat-harness/src/test-common.ts";

const load = () => {
  const proc = createProcessShim();
  const errors: string[] = [];
  const logs: string[] = [];
  const mod = { exports: {} as Record<string, any> };
  const assertStub = Object.assign(() => {}, {
    ifError: (e: unknown) => {
      if (e) throw e;
    },
    fail: (m: string) => {
      throw new Error(m);
    },
  });
  new Function("module", "require", "process", "console", commonIndexSource)(
    mod,
    () => assertStub,
    proc,
    { error: (m: string) => errors.push(m), log: (m: string) => logs.push(m) },
  );
  const finish = (): number => {
    try {
      proc.emit("exit", proc.exitCode ?? 0);
    } catch (e) {
      if (e instanceof ProcessExit) return e.code;
      throw e;
    }
    return proc.exitCode ?? 0;
  };
  return { common: mod.exports, proc, errors, logs, finish };
};

describe("faithful test common stub", () => {
  it("mustCall never called -> exit 1", () => {
    const { common, finish, errors } = load();
    common.mustCall(() => {});
    expect(finish()).toBe(1);
    expect(errors[0]).toMatch(/Expected 1, actual 0/);
  });
  it("mustCall called the right number of times -> exit 0", () => {
    const { common, finish } = load();
    const fn = common.mustCall(() => {}, 2);
    fn();
    fn();
    expect(finish()).toBe(0);
  });
  it("mustCall called too often -> exit 1", () => {
    const { common, finish } = load();
    const fn = common.mustCall(() => {});
    fn();
    fn();
    expect(finish()).toBe(1);
  });
  it("mustCallAtLeast", () => {
    const a = load();
    a.common.mustCallAtLeast(() => {}, 2)();
    expect(a.finish()).toBe(1);
    const b = load();
    const f = b.common.mustCallAtLeast(() => {}, 2);
    f();
    f();
    f();
    expect(b.finish()).toBe(0);
  });
  it("mustSucceed rejects a truthy error", () => {
    const { common } = load();
    const fn = common.mustSucceed(() => {});
    expect(() => fn(new Error("x"))).toThrow("x");
  });
  it("mustNotCall throws", () => {
    expect(() => load().common.mustNotCall("no")()).toThrow(/no/);
  });
  it("skip prints TAP SKIP and exits 0", () => {
    const { common, logs } = load();
    expect(() => common.skip("nope")).toThrow(ProcessExit);
    expect(logs[0]).toBe("1..0 # SKIP nope");
  });
  it("expectExitCode: matching code passes, mismatch fails", () => {
    const a = load();
    a.common.expectExitCode(3);
    a.proc.exitCode = 3;
    expect(a.finish()).toBe(0);
    const b = load();
    b.common.expectExitCode(3);
    expect(b.finish()).toBe(1);
  });
  it("platformTimeout is identity on linux/x64 and supports bigint", () => {
    const { common } = load();
    expect(common.platformTimeout(100)).toBe(100);
    expect(common.platformTimeout(100n)).toBe(100n);
  });
});
