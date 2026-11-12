import { describe, expect, it } from "vitest";
import { installStructuredCloneFallback, snapshotEnv, wrapEnv } from "./env-snapshot.js";

describe("snapshotEnv", () => {
  it("returns a plain string record safe for structuredClone", () => {
    const backing: Record<string, string> = { A: "1", B: "x" };
    const env = new Proxy(backing, {
      set: (t, key, value) => {
        t[key as string] = String(value);
        return true;
      },
    });
    const snap = snapshotEnv(env);
    expect(snap).toEqual({ A: "1", B: "x" });
    expect(Object.getPrototypeOf(snap)).toBe(Object.prototype);
    expect(() => structuredClone(snap)).not.toThrow();
  });

  it("coerces values through String()", () => {
    expect(snapshotEnv({ N: 42 as unknown as string, U: undefined })).toEqual({
      N: "42",
      U: "undefined",
    });
  });

  it("returns an empty record for non-objects", () => {
    expect(snapshotEnv(undefined)).toEqual({});
    expect(snapshotEnv("x")).toEqual({});
  });
});

describe("wrapEnv", () => {
  it("ignores empty-name assignments (POSIX semantics)", () => {
    const backing: Record<string, string> = { A: "1" };
    const env = wrapEnv(
      new Proxy(backing, {
        set: (t, key, value) => {
          t[key as string] = String(value);
          return true;
        },
      }) as Record<string, string>,
    );
    env[""] = "";
    expect(env[""]).toBeUndefined();
    env.B = "2";
    expect(env.B).toBe("2");
  });
});

describe("installStructuredCloneFallback", () => {
  it("clones the coercion-proxy env that native structuredClone rejects", () => {
    installStructuredCloneFallback();
    const backing: Record<string, string> = { NODE_PROCESS_ENV: "42" };
    const env = new Proxy(backing, {
      set: (t, key, value) => {
        t[key as string] = String(value);
        return true;
      },
    });
    const cloned = structuredClone(env) as Record<string, string>;
    expect(cloned).toEqual({ NODE_PROCESS_ENV: "42" });
    expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
  });

  it("preserves cycles in the snapshot retry", () => {
    installStructuredCloneFallback();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const backing = { cyclic };
    const proxy = new Proxy(backing, {});
    const cloned = structuredClone(proxy) as { cyclic: { self: unknown } };
    expect(cloned.cyclic.self).toBe(cloned.cyclic);
  });

  it("rethrows non-DataClone errors and still rejects functions", () => {
    installStructuredCloneFallback();
    expect(() => structuredClone(() => {})).toThrow();
    expect(() => structuredClone(undefined, { transfer: [] })).not.toThrow();
  });
});
