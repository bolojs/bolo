import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createLiveShimRegistry } from "./live.js";
import {
  createWorkerThreadsBackend,
  createParentPortBridge,
  spawnedProcessToWorkerLike,
} from "./worker-threads-shim.js";
import type { ProcessSpawnSpec, SpawnedProcess } from "./worker-threads-shim.js";

interface WorkerThreadsModule {
  Worker: new (
    filename: string,
    opts?: Record<string, unknown>,
  ) => {
    on(event: string, cb: (...args: any[]) => void): unknown;
    postMessage(v: unknown): void;
    terminate(): Promise<number>;
    threadId: number;
  };
  isMainThread: boolean;
  parentPort: unknown;
  workerData: unknown;
  threadId: number;
}

interface ChildProcessModule {
  fork(
    modulePath: string,
    args?: string[],
    options?: Record<string, unknown>,
  ): {
    on(event: string, cb: (...args: any[]) => void): unknown;
    send(m: unknown): boolean;
    kill(): boolean;
  };
}

/**
 * In-test process spawner: mimics the rpc-backed SpawnedProcess the runtime
 * injects — runs `spec.code` in a Function scope with a loopback parentPort,
 * and reports IPC envelopes verbatim (like a forked child process would).
 */
const fakeProcessSpawner = () => {
  const spawned: Array<{
    spec: ProcessSpawnSpec;
    proc: SpawnedProcess;
    toParent(v: unknown): void;
  }> = [];
  const spawnProcess = (spec: ProcessSpawnSpec): SpawnedProcess => {
    let onMessage: ((v: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    const listeners = new Set<(v: unknown) => void>();
    const parentPort = {
      postMessage: (v: unknown) => queueMicrotask(() => onMessage?.(v)),
      on: (_e: string, f: (v: unknown) => void) => listeners.add(f),
      once: (_e: string, f: (v: unknown) => void) => listeners.add(f),
    };
    const proc: SpawnedProcess = {
      postMessage: (v) => queueMicrotask(() => listeners.forEach((f) => f(v))),
      terminate: () => {},
      setOnStdout: () => {},
      setOnStderr: () => {},
      setOnMessage: (cb) => {
        onMessage = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
      setOnError: () => {},
    };
    spawned.push({ spec, proc, toParent: (v) => onMessage?.(v) });
    queueMicrotask(() => {
      try {
        const fn = new Function(
          "parentPort",
          "workerData",
          "isMainThread",
          "process",
          spec.code ?? "",
        );
        fn(parentPort, spec.workerData, false, {
          send: (m: unknown) => queueMicrotask(() => onMessage?.({ type: "IPC_MESSAGE", data: m })),
          exit: (c?: number) => onExit?.(c ?? 0),
        });
        if (spec.code !== undefined) onExit?.(0);
      } catch {
        onExit?.(1);
      }
    });
    return proc;
  };
  return { spawnProcess, spawned };
};

describe("worker_threads backend", () => {
  it("registry worker_threads spawns via spawnProcess and echoes workerData", async () => {
    const { spawnProcess, spawned } = fakeProcessSpawner();
    const registry = createLiveShimRegistry({ vfs: new VfsBus(), spawnProcess });
    const wt = registry.worker_threads as WorkerThreadsModule;
    expect(wt.isMainThread).toBe(true);

    const worker = new wt.Worker(`parentPort.postMessage(workerData + "!")`, {
      eval: true,
      workerData: "hi",
    });
    const message = await new Promise((resolve) => worker.on("message", resolve));
    expect(message).toBe("hi!");
    expect(spawned[0].spec.workerData).toBe("hi");
    expect(typeof spawned[0].spec.threadId).toBe("number");
  });

  it("workerThread context reports isMainThread false with workerData + parentPort", () => {
    const { port, deliver } = createParentPortBridge(() => {});
    const shim = createWorkerThreadsBackend({
      thread: { workerData: "payload", parentPort: port, threadId: 5 },
    }) as unknown as WorkerThreadsModule;
    expect(shim.isMainThread).toBe(false);
    expect(shim.workerData).toBe("payload");
    expect(shim.threadId).toBe(5);
    expect(shim.parentPort).toBe(port);
    void deliver;
  });

  it("parentPort bridge posts up and delivers down", () => {
    const posted: unknown[] = [];
    const { port, deliver } = createParentPortBridge((v) => posted.push(v));
    port.postMessage("up");
    expect(posted).toEqual(["up"]);
    const got: unknown[] = [];
    port.on("message", (v) => got.push(v));
    deliver("down");
    expect(got).toEqual(["down"]);
  });

  it("fork works over spawnProcess (stdout stream + IPC envelopes)", async () => {
    const { spawnProcess, spawned } = fakeProcessSpawner();
    const registry = createLiveShimRegistry({ vfs: new VfsBus(), spawnProcess });
    const cp = registry.child_process as ChildProcessModule;
    const child = cp.fork("./child.js", ["--flag"], { env: { FOO: "bar" } });
    expect(spawned[0].spec.filename).toBe("./child.js");
    expect(spawned[0].spec.args).toEqual(["--flag"]);
    expect(spawned[0].spec.env).toEqual({ FOO: "bar" });

    // Child → parent IPC arrives as a 'message' event.
    const ipc = new Promise((resolve) => child.on("message", resolve));
    spawned[0].toParent({ type: "IPC_MESSAGE", data: "pong" });
    expect(await ipc).toBe("pong");
  });

  it("spawnedProcessToWorkerLike maps exit + IPC envelopes", () => {
    let onMessage: ((v: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    const proc: SpawnedProcess = {
      postMessage: () => {},
      terminate: () => {},
      setOnStdout: () => {},
      setOnStderr: () => {},
      setOnMessage: (cb) => {
        onMessage = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
      setOnError: () => {},
    };
    const workerLike = spawnedProcessToWorkerLike(proc);
    const seen: unknown[] = [];
    workerLike.onmessage = (ev) => seen.push(ev.data);
    onMessage!({ type: "IPC_MESSAGE", data: "hello" });
    onMessage!("raw");
    onExit!(0);
    expect(seen).toEqual([
      { type: "IPC_MESSAGE", data: "hello" },
      { type: "IPC_MESSAGE", data: "raw" },
      { type: "exit", code: 0 },
    ]);
  });
});
