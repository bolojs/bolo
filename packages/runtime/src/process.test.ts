import { describe, expect, it, vi } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createProcess } from "./process.js";
import { ShellService } from "./shell-service.js";
import { RuntimeWorker } from "./runtime-worker.js";

describe("createProcess", () => {
  it("should spawn shell command and return exit code", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("npm", ["install"], {}, { vfs, shell, runtimeWorker });

    expect(proc.output).toBeInstanceOf(ReadableStream);
    const exitCode = await proc.exit;
    expect(exitCode).toBe(0);
    expect(shell.execute).toHaveBeenCalledWith("npm install", {
      stdout: expect.any(Function),
      stderr: expect.any(Function),
    });
  });

  it("should stream shell stdout and stderr", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockImplementation((_cmd, output) => {
        output?.stdout?.("hello ");
        output?.stderr?.("error ");
        return Promise.resolve({ exitCode: 0 });
      }),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("echo", ["hi"], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toEqual(["hello ", "error "]);
  });

  it("should route runtime run through shell service", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("runtime", ["run", "/script.js"], {}, { vfs, shell, runtimeWorker });

    const exitCode = await proc.exit;
    expect(exitCode).toBe(0);
    expect(shell.execute).toHaveBeenCalledWith("runtime run /script.js", {
      stdout: expect.any(Function),
      stderr: expect.any(Function),
    });
  });

  it("should route runtime run without file path through shell service", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockResolvedValue({ exitCode: 1 }),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("runtime", ["run"], {}, { vfs, shell, runtimeWorker });

    expect(await proc.exit).toBe(1);
    expect(shell.execute).toHaveBeenCalledWith("runtime run", {
      stdout: expect.any(Function),
      stderr: expect.any(Function),
    });
  });

  it("should kill process with exit code 1", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("sleep", ["10"], {}, { vfs, shell, runtimeWorker });
    proc.kill();
    expect(await proc.exit).toBe(1);
    // runtimeWorker is shared across every process in the container; killing
    // one process must not tear it down and take unrelated processes with it.
    expect(runtimeWorker.dispose).not.toHaveBeenCalled();
  });

  it("should not affect a second in-flight process sharing the same runtimeWorker when one is killed", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const devServer = createProcess("npm", ["run", "dev"], {}, { vfs, shell, runtimeWorker });
    const install = createProcess("npm", ["install"], {}, { vfs, shell, runtimeWorker });

    install.kill();

    expect(await install.exit).toBe(1);
    expect(runtimeWorker.dispose).not.toHaveBeenCalled();
    // The dev server process's exit promise must remain unresolved — killing
    // `install` must not have terminated the shared worker it depends on.
    const raced = await Promise.race([
      devServer.exit.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(raced).toBe("pending");
  });

  it("should handle shell command errors", async () => {
    const vfs = new VfsBus();
    const shell = {
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as ShellService;
    const runtimeWorker = { dispose: vi.fn() } as unknown as RuntimeWorker;
    const proc = createProcess("bad", [], {}, { vfs, shell, runtimeWorker });

    const reader = proc.output.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks[0]).toContain("boom");
    expect(await proc.exit).toBe(1);
  });
});
