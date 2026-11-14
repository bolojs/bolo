import { describe, it, expect } from "vitest";
import { createProcessShim } from "./process-shim.js";

describe("createProcessShim", () => {
  it("routes stdout/stderr writes to the supplied callbacks instead of discarding them", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const process = createProcessShim({
      onStdout: (d) => stdout.push(d),
      onStderr: (d) => stderr.push(d),
    });

    process.stdout.write("hello\n");
    process.stderr.write("oops\n");

    expect(stdout).toEqual(["hello\n"]);
    expect(stderr).toEqual(["oops\n"]);
  });

  it("reports platform as browser and exposes cwd/chdir", () => {
    const process = createProcessShim({ cwd: "/home/web" });

    expect(process.platform).toBe("browser");
    expect(process.cwd()).toBe("/home/web");
    process.chdir("/tmp");
    expect(process.cwd()).toBe("/tmp");
  });

  it("reports memory usage with the expected shape", () => {
    const process = createProcessShim();
    const usage = process.memoryUsage();

    expect(usage).toHaveProperty("rss");
    expect(usage).toHaveProperty("heapTotal");
    expect(usage).toHaveProperty("heapUsed");
    expect(usage).toHaveProperty("external");
    expect(usage).toHaveProperty("arrayBuffers");
    expect(typeof process.memoryUsage.rss()).toBe("number");
  });

  it("zeros external and arrayBuffers while preserving heap values", () => {
    (performance as any).memory = { totalHeapSize: 1000, usedHeapSize: 500 };
    try {
      const process = createProcessShim();
      const usage = process.memoryUsage();

      expect(usage.heapTotal).toBe(1000);
      expect(usage.heapUsed).toBe(500);
      expect(usage.rss).toBe(1000);
      expect(usage.external).toBe(0);
      expect(usage.arrayBuffers).toBe(0);
    } finally {
      delete (performance as any).memory;
    }
  });

  it("validates nextTick callbacks with ERR_INVALID_ARG_TYPE", () => {
    const process = createProcessShim();
    for (const bad of [false, 1, "str", {}, []]) {
      expect(() => process.nextTick(bad as never)).toThrow(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }),
      );
    }
  });

  it("sets _exiting on exit and ignores nextTick scheduled afterwards", () => {
    const process = createProcessShim();
    let late = false;
    process.on("exit", () => {
      expect(process._exiting).toBe(true);
      process.nextTick(() => {
        late = true;
      });
    });
    process.emit("exit", 0);
    process.drainTicks();
    expect(late).toBe(false);
  });

  it("coerces env values to strings on write and delete (test-process-env)", () => {
    const process = createProcessShim({ env: { INITIAL: "yes", NUM: 42 as never } });

    expect(process.env.INITIAL).toBe("yes");
    // Values passed in non-string form are coerced eagerly too.
    expect(process.env.NUM).toBe("42");

    (process.env as Record<string, unknown>).SET_LATER = 42;
    expect(process.env.SET_LATER).toBe("42");
    (process.env as Record<string, unknown>).SET_NULL = null;
    expect(process.env.SET_NULL).toBe("null");

    delete (process.env as Record<string, unknown>).SET_LATER;
    expect(process.env.SET_LATER).toBeUndefined();
    expect("INITIAL" in process.env).toBe(true);
    expect(Object.keys(process.env)).toEqual(expect.arrayContaining(["INITIAL", "NUM"]));
  });

  it("exposes arch/execPath/release/features/config metadata", () => {
    const process = createProcessShim();

    expect(typeof process.arch).toBe("string");
    expect(process.arch.length).toBeGreaterThan(0);
    expect(process.execPath).toContain("node");
    expect(process.release.name).toBe("node");
    expect(process.release.version).toBe(process.versions.node);
    expect(process.features).toMatchObject({ inspector: false, tls: false });
    expect(process.config).toMatchObject({ target_defaults: {}, variables: {} });
  });

  it("emitWarning emits 'warning' with a named Error and prints to stderr", () => {
    const stderr: string[] = [];
    const process = createProcessShim({ onStderr: (d) => stderr.push(d) });

    const warnings: Error[] = [];
    process.on("warning", (w: Error) => warnings.push(w));
    process.emitWarning("careful", "DeprecationWarning", "DEP001");

    expect(warnings).toHaveLength(1);
    expect(warnings[0].name).toBe("DeprecationWarning");
    expect(warnings[0].message).toBe("careful");
    expect((warnings[0] as Error & { code?: string }).code).toBe("DEP001");
    expect(stderr.join("")).toContain("DeprecationWarning: careful");
  });

  it("emitWarning accepts an options object and Error input", () => {
    const process = createProcessShim();
    const warnings: Error[] = [];
    process.on("warning", (w: Error) => warnings.push(w));

    process.emitWarning(new TypeError("typed"), { type: "TypeWarning", detail: "extra" });
    expect(warnings[0]).toBeInstanceOf(TypeError);
    expect(warnings[0].name).toBe("TypeWarning");
    expect((warnings[0] as Error & { detail?: string }).detail).toBe("extra");
  });

  it("setUncaughtExceptionCaptureCallback replaces the 'uncaughtException' emit", () => {
    const process = createProcessShim();
    const captured: unknown[] = [];
    const listened: unknown[] = [];

    expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false);
    process.setUncaughtExceptionCaptureCallback((err: unknown) => captured.push(err));
    expect(process.hasUncaughtExceptionCaptureCallback()).toBe(true);

    process.on("uncaughtException", (err: unknown) => listened.push(err));
    const boom = new Error("boom");
    process.emit("uncaughtException", boom);

    // The capture callback replaces the emit — listeners are NOT called.
    expect(captured).toEqual([boom]);
    expect(listened).toEqual([]);

    process.setUncaughtExceptionCaptureCallback(null);
    process.emit("uncaughtException", boom);
    expect(listened).toEqual([boom]);

    expect(() => process.setUncaughtExceptionCaptureCallback(42 as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("getBuiltinModule resolves node builtins through the injected registry", () => {
    const shims = { fs: { readFile: () => {} }, "node:path": "should-not-hit" };
    const process = createProcessShim({
      getBuiltinModule: (name) => (shims as Record<string, unknown>)[name],
    });

    expect(process.getBuiltinModule("fs")).toBe(shims.fs);
    expect(process.getBuiltinModule("node:fs")).toBe(shims.fs);
    expect(process.getBuiltinModule("fs")).toBe(process.getBuiltinModule("node:fs"));
    expect(process.getBuiltinModule("nonexistent")).toBeUndefined();
  });

  it("getBuiltinModule returns undefined when no registry is injected", () => {
    const process = createProcessShim();
    expect(process.getBuiltinModule("fs")).toBeUndefined();
  });
});

describe("process.exit re-entrancy", () => {
  it("does not re-emit 'exit' when exit() is called from an exit handler", () => {
    const process = createProcessShim();
    let exits = 0;
    let finalCode: number | undefined;
    process.on("exit", (code) => {
      exits++;
      expect(code).toBe(1);
      expect(() => process.exit(0)).toThrow(expect.objectContaining({ code: 0 }));
      finalCode = process.exitCode;
    });
    expect(() => process.exit(1)).toThrow(expect.objectContaining({ code: 0 }));
    expect(exits).toBe(1);
    expect(finalCode).toBe(0);
  });

  it("emits 'exit' exactly once on repeated exit() calls", () => {
    const process = createProcessShim();
    let exits = 0;
    process.on("exit", () => {
      exits++;
    });
    expect(() => process.exit()).toThrow();
    expect(() => process.exit(3)).toThrow(expect.objectContaining({ code: 3 }));
    expect(exits).toBe(1);
  });
});

describe("process.exitCode validation", () => {
  it("rejects invalid exit codes with Node's exact error shapes", () => {
    const process = createProcessShim();
    // Non-numbers: ERR_INVALID_ARG_TYPE.
    for (const bad of ["", "1 one", "two", {}, [], true, false, 2n]) {
      expect(() => {
        (process as unknown as { exitCode: unknown }).exitCode = bad;
      }).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", name: "TypeError" }));
    }
    // Non-integral numbers: ERR_OUT_OF_RANGE (Node's validateInteger).
    for (const bad of [2.1, Infinity, NaN]) {
      expect(() => {
        (process as unknown as { exitCode: unknown }).exitCode = bad;
      }).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE", name: "TypeError" }));
    }
    // Message parity with Node 22 for the shapes the vendored test regexes.
    expect(() => {
      (process as unknown as { exitCode: unknown }).exitCode = 2.1;
    }).toThrow(/Received 2\.1$/);
    expect(() => {
      (process as unknown as { exitCode: unknown }).exitCode = "two";
    }).toThrow(/Received type string \('two'\)$/);
    expect(() => {
      (process as unknown as { exitCode: unknown }).exitCode = {};
    }).toThrow(/Received an instance of Object$/);
    expect(() => {
      (process as unknown as { exitCode: unknown }).exitCode = [];
    }).toThrow(/Received an instance of Array$/);
  });

  it("accepts integers and numeric strings, coercing them", () => {
    const process = createProcessShim();
    const target = process as unknown as { exitCode: unknown };
    target.exitCode = 1;
    expect(process.exitCode).toBe(1);
    target.exitCode = "2";
    expect(process.exitCode).toBe(2);
    target.exitCode = "0";
    expect(process.exitCode).toBe(0);
    target.exitCode = undefined;
    expect(process.exitCode).toBeUndefined();
    target.exitCode = null;
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses to delete exitCode with Node's message", () => {
    const process = createProcessShim();
    expect(() => {
      delete (process as unknown as { exitCode: unknown }).exitCode;
    }).toThrow("Cannot delete property 'exitCode' of #<process>");
  });

  it("process.exit validates the code argument too", () => {
    const process = createProcessShim();
    expect(() => (process as unknown as { exit(code: string): void }).exit("two")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});
