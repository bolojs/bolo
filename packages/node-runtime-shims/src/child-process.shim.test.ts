import { describe, it, expect } from "vitest";
import { createChildProcessShim } from "./child-process-shim.js";
import type child_process from "node:child_process";

describe("child_process shim", () => {
  it("spawn uses registry when available", async () => {
    const registry = {
      dispatch: async (_cmd: string, _args: string[]) => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      }),
    };
    const shim = createChildProcessShim(registry);
    const _typeCheck: typeof child_process = shim as unknown as typeof child_process;
    void _typeCheck;

    let exitCode: number | null = null;
    const child = shim.spawn("tsc", ["--version"]);
    child.on("close", (code) => {
      exitCode = code;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);
  });

  it("spawn falls back to shell service", async () => {
    const shell = {
      exec: async (_cmd: string, _args: string[]) => ({ stdout: "out", stderr: "", exitCode: 0 }),
    };
    const shim = createChildProcessShim(undefined, shell);

    let exitCode: number | null = null;
    const child = shim.spawn("echo", ["hello"]);
    child.on("close", (code) => {
      exitCode = code;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(0);
  });

  it("spawn errors when no registry or shell", async () => {
    const shim = createChildProcessShim();

    let exitCode: number | null = null;
    const child = shim.spawn("unknown", []);
    child.on("close", (code) => {
      exitCode = code;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(exitCode).toBe(1);
  });

  it("spawn exposes stdout/stderr as real streams emitting the dispatched output (A6)", async () => {
    const registry = {
      dispatch: async (_cmd: string, _args: string[]) => ({
        stdout: "out-line",
        stderr: "err-line",
        exitCode: 0,
      }),
    };
    const shim = createChildProcessShim(registry);
    const child = shim.spawn("tool", []);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on("data", (chunk: { toString(): string }) => stdoutChunks.push(chunk.toString()));
    child.stderr.on("data", (chunk: { toString(): string }) => stderrChunks.push(chunk.toString()));

    let closed = false;
    child.on("close", () => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(closed).toBe(true);
    expect(stdoutChunks.join("")).toBe("out-line");
    expect(stderrChunks.join("")).toBe("err-line");
    expect(typeof child.stdin.write).toBe("function");
  });

  it("exec callback receives the real dispatched stdout/stderr (A6)", async () => {
    const registry = {
      dispatch: async (_cmd: string, _args: string[]) => ({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      }),
    };
    const shim = createChildProcessShim(registry);

    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
      (resolve) => {
        shim.exec("echo hello", (error: Error | null, stdout: string, stderr: string) =>
          resolve({ error, stdout, stderr }),
        );
      },
    );

    expect(result.error).toBeNull();
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
  });

  it("exec callback receives an error on non-zero exit (A6)", async () => {
    const registry = {
      dispatch: async (_cmd: string, _args: string[]) => ({
        stdout: "",
        stderr: "boom",
        exitCode: 1,
      }),
    };
    const shim = createChildProcessShim(registry);

    const result = await new Promise<{ error: Error | null }>((resolve) => {
      shim.exec("fail", (error: Error | null) => resolve({ error }));
    });

    expect(result.error).toBeInstanceOf(Error);
  });

  it("execSync and spawnSync throw a clear unsupported-environment error (A6)", () => {
    const shim = createChildProcessShim();
    expect(() => shim.execSync()).toThrow(/not supported/);
    expect(() => shim.spawnSync()).toThrow(/not supported/);
  });

  it("execFile dispatches file + argv and reports stdout via callback", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const registry = {
      dispatch: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { stdout: "listed", stderr: "", exitCode: 0 };
      },
    };
    const shim = createChildProcessShim(registry);

    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
      (resolve) => {
        shim.execFile(
          "tool",
          ["--flag", "x"],
          (error: Error | null, stdout: string, stderr: string) =>
            resolve({ error, stdout, stderr }),
        );
      },
    );

    expect(calls).toEqual([{ cmd: "tool", args: ["--flag", "x"] }]);
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("listed");
    expect(result.stderr).toBe("");
  });

  it("execFile callback receives an error with code on non-zero exit", async () => {
    const registry = {
      dispatch: async () => ({ stdout: "", stderr: "nope", exitCode: 2 }),
    };
    const shim = createChildProcessShim(registry);

    const result = await new Promise<{ error: (Error & { code?: number }) | null }>((resolve) => {
      shim.execFile("fail", [], (error: Error & { code?: number }) => resolve({ error }));
    });

    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.code).toBe(2);
  });

  it("execFileSync throws the same unsupported-environment error", () => {
    const shim = createChildProcessShim();
    expect(() => shim.execFileSync()).toThrow(/not supported/);
  });

  it("exports every named key Node's child_process exposes (globby/del link check)", () => {
    const shim = createChildProcessShim();
    for (const name of [
      "spawn",
      "exec",
      "execFile",
      "fork",
      "execSync",
      "execFileSync",
      "spawnSync",
      "ChildProcess",
    ]) {
      expect(typeof (shim as Record<string, unknown>)[name], `child_process.${name}`).toBe(
        "function",
      );
    }
  });

  it("spawned children carry Node's spawn metadata fields", async () => {
    const registry = {
      dispatch: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const shim = createChildProcessShim(registry);
    const child = shim.spawn("tool", ["a", "b"]) as unknown as Record<string, unknown>;

    expect(child.spawnfile).toBe("tool");
    expect(child.spawnargs).toEqual(["tool", "a", "b"]);
    expect(child.signalCode).toBeNull();
    expect(Array.isArray(child.stdio)).toBe(true);
    expect((child.stdio as unknown[]).length).toBe(3);
    expect(typeof child.ref).toBe("function");
    expect(typeof child.unref).toBe("function");

    (child.kill as (signal?: string) => boolean)("SIGKILL");
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });
});

describe("exec/execFile maxBuffer", () => {
  const overflowingRegistry = {
    dispatch: async (_cmd: string, _args: string[]) => ({
      stdout: "x".repeat(2048),
      stderr: "",
      exitCode: 0,
    }),
  };

  it("exec rejects stdout beyond maxBuffer with ENOBUFS", async () => {
    const shim = createChildProcessShim(overflowingRegistry);
    const result = await new Promise<{ error: (Error & { code?: string }) | null; stdout: string }>(
      (resolve) => {
        shim.exec("big", { maxBuffer: 1024 }, (error: (Error & { code?: string }) | null, stdout: string) =>
          resolve({ error, stdout }),
        );
      },
    );
    expect(result.error?.code).toBe("ENOBUFS");
    expect(result.error?.message).toMatch(/maxBuffer/);
  });

  it("exec within maxBuffer succeeds normally", async () => {
    const shim = createChildProcessShim(overflowingRegistry);
    const result = await new Promise<{ error: (Error & { code?: string }) | null; stdout: string }>(
      (resolve) => {
        shim.exec("big", { maxBuffer: 4096 }, (error: (Error & { code?: string }) | null, stdout: string) =>
          resolve({ error, stdout }),
        );
      },
    );
    expect(result.error).toBeNull();
    expect(result.stdout.length).toBe(2048);
  });

  it("execFile rejects stdout beyond maxBuffer with ENOBUFS", async () => {
    const shim = createChildProcessShim(overflowingRegistry);
    const result = await new Promise<{ error: (Error & { code?: string }) | null }>((resolve) => {
      shim.execFile("big", { maxBuffer: 100 }, (error: (Error & { code?: string }) | null) =>
        resolve({ error }),
      );
    });
    expect(result.error?.code).toBe("ENOBUFS");
  });
});
