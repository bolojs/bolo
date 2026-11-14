import { describe, it, expect } from "vitest";
import { createProcessShim, ProcessExit } from "@bolojs/node-runtime-shims";
import { superviseRun } from "./supervise-run.js";

const harness = () => {
  const stderr: string[] = [];
  const target = new EventTarget();
  const proc = createProcessShim();
  const run = (fn: () => Promise<unknown> | unknown, quiescenceCapMs = 500) =>
    superviseRun({
      process: proc,
      run: async () => fn(),
      stderr: (d) => stderr.push(d),
      target,
      quiescenceCapMs,
    });
  return { proc, stderr, target, run };
};

describe("superviseRun (canaries: each must NOT exit 0)", () => {
  it("process.exit(1) -> 1 and terminated", async () => {
    const h = harness();
    const r = await h.run(() => h.proc.exit(1));
    expect(r).toEqual({ exitCode: 1, terminated: true });
  });

  it("top-level throw -> 1 with Node-formatted stderr", async () => {
    const h = harness();
    const r = await h.run(() => {
      throw new Error("sync boom");
    });
    expect(r.exitCode).toBe(1);
    expect(h.stderr.join("")).toMatch(/Uncaught .*sync boom[\s\S]*Node\.js v22\.12\.0/);
  });

  it("throw inside a timeout -> 1", async () => {
    const h = harness();
    const r = await h.run(() => {
      setTimeout(() => {
        const error = new Error("boom");
        h.target.dispatchEvent(Object.assign(new Event("error"), { error }));
      }, 10);
    });
    expect(r.exitCode).toBe(1);
  });

  it("uncaught error still fires 'exit' handlers (which may rewrite the code)", async () => {
    const h = harness();
    h.proc.on("exit", () => {
      h.proc.exit(0);
    });
    const r = await h.run(() => {
      throw new Error("expected");
    });
    expect(r).toEqual({ exitCode: 0, terminated: true });
  });

  it("process.exit inside a timeout -> its code", async () => {
    const h = harness();
    const r = await h.run(() => {
      setTimeout(() => {
        try {
          h.proc.exit(3);
        } catch (error) {
          h.target.dispatchEvent(Object.assign(new Event("error"), { error }));
        }
      }, 10);
    });
    expect(r).toEqual({ exitCode: 3, terminated: true });
  });

  it("unhandled rejection -> 1 unless a handler is registered", async () => {
    const h = harness();
    const reject = (reason: unknown) =>
      h.target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    const bad = await h.run(() => reject(new Error("nope")));
    expect(bad.exitCode).toBe(1);

    const h2 = harness();
    h2.proc.on("unhandledRejection", () => {});
    const ok = await h2.run(() =>
      h2.target.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), { reason: new Error("handled") }),
      ),
    );
    expect(ok.exitCode).toBe(0);
  });

  it("process.exitCode = 2 is honoured at natural completion", async () => {
    const h = harness();
    const r = await h.run(() => {
      h.proc.exitCode = 2;
    });
    expect(r).toEqual({ exitCode: 2, terminated: false });
  });

  it("waits for pending timers (quiescence) and runs exit handlers", async () => {
    const h = harness();
    const seen: string[] = [];
    h.proc.on("exit", (c: number) => seen.push(`exit:${c}`));
    const r = await h.run(() => {
      setTimeout(() => seen.push("timer"), 20);
    });
    expect(seen).toEqual(["timer", "exit:0"]);
    expect(r.exitCode).toBe(0);
  });

  it("a never-clearing interval is capped, not hung", async () => {
    const h = harness();
    const t0 = Date.now();
    const r = await h.run(() => {
      setInterval(() => {}, 10);
    }, 80);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.exitCode).toBe(0);
  });
});

describe("process shim exit", () => {
  it("throws ProcessExit carrying the code and fires 'exit' once", () => {
    const proc = createProcessShim();
    const codes: number[] = [];
    proc.on("exit", (c: number) => codes.push(c));
    expect(() => proc.exit(4)).toThrow(ProcessExit);
    expect(() => proc.exit(5)).toThrow(ProcessExit);
    expect(codes).toEqual([4]);
  });
});
