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
});
