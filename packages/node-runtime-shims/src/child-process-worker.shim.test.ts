import { describe, it, expect, vi, afterEach } from "vitest";
import { createChildProcessShim } from "./child-process-shim.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  simulateError(error: Error): void {
    this.onerror?.({ error } as unknown as ErrorEvent);
  }
}

describe("child_process Worker spawn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Worker children get distinct monotonic pids", () => {
    const createWorker = vi.fn(() => new FakeWorker());
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child1 = shim.fork("./one.js");
    const child2 = shim.fork("./two.js");

    expect(typeof child1.pid).toBe("number");
    expect(typeof child2.pid).toBe("number");
    expect(child1.pid).not.toBe(child2.pid);
    expect(child2.pid!).toBeGreaterThan(child1.pid!);
  });

  it("spawn node script uses injected Worker factory", async () => {
    const fake = new FakeWorker();
    const createWorker = vi.fn(() => fake);
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child = shim.spawn("node", ["./script.js"], { cwd: "/", env: { FOO: "bar" } });
    expect(createWorker).toHaveBeenCalledWith("./script.js", [], { FOO: "bar" }, "/");
    expect(typeof child.pid).toBe("number");

    const stdoutChunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
    fake.simulateMessage({ stream: "stdout", data: "hello" });
    expect(stdoutChunks).toEqual(["hello"]);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    fake.simulateMessage({ stream: "stderr", data: "oops" });
    expect(stderrChunks).toEqual(["oops"]);

    child.stdin.write("input");
    expect(fake.messages).toContainEqual({ type: "stdin", data: "input" });

    let exitCode: number | null = -1;
    let closeCode: number | null = -1;
    child.on("exit", (code: number | null) => {
      exitCode = code;
    });
    child.on("close", (code: number | null) => {
      closeCode = code;
    });
    fake.simulateMessage({ type: "exit", code: 0 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitCode).toBe(0);
    expect(closeCode).toBe(0);
    expect(child.exitCode).toBe(0);
  });

  it("spawn node falls back to registry when factory returns undefined", async () => {
    const registry = { dispatch: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })) };
    const shim = createChildProcessShim(registry, undefined, { createWorker: () => undefined });

    let exitCode: number | null = null;
    const child = shim.spawn("node", ["./script.js"]);
    child.on("close", (code: number | null) => {
      exitCode = code;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registry.dispatch).toHaveBeenCalledWith("node", ["./script.js"]);
    expect(exitCode).toBe(0);
  });

  it("spawn non-node command ignores Worker factory and uses registry", async () => {
    const registry = { dispatch: vi.fn(async () => ({ stdout: "out", stderr: "", exitCode: 0 })) };
    const createWorker = vi.fn(() => new FakeWorker());
    const shim = createChildProcessShim(registry, undefined, { createWorker });

    let exitCode: number | null = null;
    const child = shim.spawn("tsc", ["--version"]);
    child.on("close", (code: number | null) => {
      exitCode = code;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createWorker).not.toHaveBeenCalled();
    expect(registry.dispatch).toHaveBeenCalledWith("tsc", ["--version"]);
    expect(exitCode).toBe(0);
  });

  it("fork delegates to Worker factory", async () => {
    const fake = new FakeWorker();
    const createWorker = vi.fn(() => fake);
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child = shim.fork("./script.js", ["--flag"], { cwd: "/app" });
    expect(createWorker).toHaveBeenCalledWith("./script.js", ["--flag"], undefined, "/app");

    fake.simulateMessage({ type: "exit", code: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.exitCode).toBe(7);
  });

  it("fork accepts options as second argument", async () => {
    const fake = new FakeWorker();
    const createWorker = vi.fn(() => fake);
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    shim.fork("./script.js", { cwd: "/app" });
    expect(createWorker).toHaveBeenCalledWith("./script.js", [], undefined, "/app");
  });

  it("fork throws clear error without Worker factory", () => {
    const shim = createChildProcessShim();
    expect(() => shim.fork("./script.js")).toThrow(/POSIX fork/);
    expect(() => shim.fork("./script.js")).toThrow(/ADR-0007/);
  });

  it("send posts IPC message to worker", () => {
    const fake = new FakeWorker();
    const createWorker = vi.fn(() => fake);
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child = shim.fork("./script.js");
    child.send?.({ hello: "world" });
    expect(fake.messages).toContainEqual({ type: "IPC_MESSAGE", data: { hello: "world" } });
  });

  class EchoWorker extends FakeWorker {
    override postMessage(message: unknown): void {
      super.postMessage(message);
      if (isRecord(message) && message.type === "IPC_MESSAGE") {
        queueMicrotask(() => this.simulateMessage({ type: "IPC_MESSAGE", data: message.data }));
      }
    }
  }

  it("fork round-trips IPC messages from host to child and back", async () => {
    const createWorker = vi.fn(() => new EchoWorker());
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child = shim.fork("./echo.js");
    const received: unknown[] = [];
    child.on("message", (msg) => received.push(msg));

    child.send?.({ hello: "world" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([{ hello: "world" }]);
  });

  it("disconnect is wired in both directions", async () => {
    const fake = new FakeWorker();
    const createWorker = vi.fn(() => fake);
    const shim = createChildProcessShim(undefined, undefined, { createWorker });

    const child = shim.fork("./script.js");
    let disconnected = false;
    child.on("disconnect", () => {
      disconnected = true;
    });

    fake.simulateMessage({ type: "IPC_DISCONNECT" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnected).toBe(true);

    child.disconnect?.();
    expect(fake.messages).toContainEqual({ type: "IPC_DISCONNECT" });
  });

  it("worker error emits error event", async () => {
    const fake = new FakeWorker();
    const shim = createChildProcessShim(undefined, undefined, { createWorker: () => fake });

    const child = shim.fork("./script.js");
    let error: unknown = null;
    child.on("error", (err: unknown) => {
      error = err;
    });
    fake.simulateError(new Error("boom"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
  });
});
