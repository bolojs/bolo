import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RuntimeWorker } from "./runtime-worker.js";
import type { RuntimeMessage } from "./runtime-worker.js";

const createMockWorker = () => {
  let onmessage: ((ev: MessageEvent) => void) | null = null;
  let terminated = false;

  return {
    instance: {
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        onmessage = fn;
      },
      get onmessage() {
        return onmessage;
      },
      postMessage: vi.fn(),
      terminate: vi.fn(() => {
        terminated = true;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Worker,
    simulateMessage: (msg: RuntimeMessage) => {
      onmessage?.(new MessageEvent("message", { data: msg }));
    },
    isTerminated: () => terminated,
  };
};

describe("RuntimeWorker", () => {
  let worker: RuntimeWorker;
  let mockVfs: { mount: ReturnType<typeof vi.fn> };
  let mockSandbox: { start: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    mockVfs = { mount: vi.fn() };
    mockSandbox = { start: vi.fn() };
    worker = new RuntimeWorker(mockVfs as never, mockSandbox as never);
  });

  afterEach(() => {
    worker.dispose();
    vi.useRealTimers();
  });

  it("should capture stdout from runScript", async () => {
    const mockWorker = createMockWorker();

    // Override global Worker constructor
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        return mockWorker.instance;
      }),
    );

    const stdoutData: string[] = [];
    worker.onStdout = (data) => stdoutData.push(data);

    const runPromise = worker.runScript("console.log(42)");

    // Simulate worker posting back stdout then exit
    mockWorker.simulateMessage({ type: "STDOUT", data: "42" });
    mockWorker.simulateMessage({ type: "EXIT", code: 0 });

    await runPromise;

    expect(stdoutData).toEqual(["42"]);
    expect(mockWorker.instance.postMessage).toHaveBeenCalledWith({
      type: "RUN_SCRIPT",
      code: "console.log(42)",
      opts: {},
    });
  });

  it("should capture stderr and exit code on error", async () => {
    const mockWorker = createMockWorker();
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        return mockWorker.instance;
      }),
    );

    const stderrData: string[] = [];
    let exitCode: number | null = null;
    worker.onStderr = (data) => stderrData.push(data);
    worker.onExit = (code) => {
      exitCode = code;
    };

    const runPromise = worker.runScript('throw new Error("boom")');

    mockWorker.simulateMessage({ type: "STDERR", data: "Error: boom" });
    mockWorker.simulateMessage({ type: "EXIT", code: 1 });

    await runPromise;

    expect(stderrData).toEqual(["Error: boom"]);
    expect(exitCode).toBe(1);
  });

  it("should terminate worker after missed heartbeats", async () => {
    const mockWorker = createMockWorker();
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        return mockWorker.instance;
      }),
    );

    const exitCode: number[] = [];
    worker.onExit = (code) => exitCode.push(code);

    const runPromise = worker.runScript("while(true){}");

    // First heartbeat check (5s) — no heartbeat received, missedHeartbeats=1
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() => expect(mockWorker.instance.terminate).not.toHaveBeenCalled());

    // Second check (10s) — still no heartbeat, missedHeartbeats=2, should terminate
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() => expect(mockWorker.instance.terminate).toHaveBeenCalled());

    await expect(runPromise).rejects.toThrow();
  });

  it("should reset missed heartbeats on heartbeat message", async () => {
    const mockWorker = createMockWorker();
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        return mockWorker.instance;
      }),
    );

    const runPromise = worker.runScript('console.log("hello")');

    // Advance to first check
    vi.advanceTimersByTime(5000);

    // Send heartbeat before second check
    mockWorker.simulateMessage({ type: "HEARTBEAT" });

    // Advance to second check — heartbeat was received, should NOT terminate
    vi.advanceTimersByTime(5000);
    expect(mockWorker.instance.terminate).not.toHaveBeenCalled();

    // Clean up
    mockWorker.simulateMessage({ type: "EXIT", code: 0 });
    await runPromise;
  });

  it("should dispose cleanly", () => {
    const mockWorker = createMockWorker();
    vi.stubGlobal(
      "Worker",
      vi.fn(function () {
        return mockWorker.instance;
      }),
    );

    worker.dispose();

    // Calling dispose again should be safe
    worker.dispose();
  });
});
