import { describe, it, expect } from "vitest";
import {
  createWorkerThreadsShim,
  type WorkerThreadHandle,
  type WorkerThreadSpawnSpec,
} from "../src/worker_threads.ts";

/**
 * In-test spawner: runs `spec.code` (eval-mode) in a fresh Function scope
 * with `parentPort`/`workerData`/`isMainThread` bound — the same shape the
 * container's WORKER_EVAL_PRELUDE gives real process workers.
 */
const evalSpawner = () => {
  const spawned: Array<{ spec: WorkerThreadSpawnSpec; deliver(v: unknown): void }> = [];
  const spawner = (spec: WorkerThreadSpawnSpec): WorkerThreadHandle => {
    let onMessage: ((v: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    let onError: ((e: unknown) => void) | null = null;
    const listeners = new Set<(v: unknown) => void>();
    const parentPort = {
      postMessage: (v: unknown) => queueMicrotask(() => onMessage?.(v)),
      on: (_e: string, f: (v: unknown) => void) => listeners.add(f),
      once: (_e: string, f: (v: unknown) => void) => listeners.add(f),
      close: () => listeners.clear(),
      start: () => {},
      ref: () => parentPort,
      unref: () => parentPort,
    };
    const deliver = (v: unknown) => listeners.forEach((f) => f(v));
    spawned.push({ spec, deliver });
    queueMicrotask(() => {
      try {
        const fn = new Function(
          "parentPort",
          "workerData",
          "isMainThread",
          "MessageChannel",
          "process",
          spec.code ?? "",
        );
        fn(parentPort, spec.workerData, false, globalThis.MessageChannel, {
          exit: (c?: number) => onExit?.(c ?? 0),
        });
        onExit?.(0);
      } catch (err) {
        onError?.(err);
      }
    });
    return {
      postMessage: (v) => queueMicrotask(() => deliver(v)),
      terminate: () => {},
      setOnMessage: (cb) => {
        onMessage = cb;
      },
      setOnError: (cb) => {
        onError = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
    };
  };
  return { spawner, spawned };
};

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("node-web-shims: worker_threads", () => {
  it("should match node:worker_threads type shape", () => {
    const shim = createWorkerThreadsShim();
    const _nodeWorkerThreads: typeof import("node:worker_threads") = shim;
    expect(_nodeWorkerThreads).toBeDefined();
  });

  it("reports the main-thread surface", () => {
    const shim = createWorkerThreadsShim();
    expect(shim.isMainThread).toBe(true);
    expect(shim.parentPort).toBeNull();
    expect(shim.workerData).toBeUndefined();
    expect(shim.threadId).toBe(0);
    expect(shim.SHARE_ENV).toBeDefined();
    expect(typeof shim.BroadcastChannel).toBe("function");
    expect(typeof shim.MessageChannel).toBe("function");
    expect(typeof shim.MessagePort).toBe("function");
    expect(typeof shim.receiveMessageOnPort).toBe("function");
    expect(typeof shim.markAsUntransferable).toBe("function");
    expect(typeof shim.markAsUncloneable).toBe("function");
    expect(typeof shim.moveMessagePortToContext).toBe("function");
    expect(typeof shim.setEnvironmentData).toBe("function");
    expect(typeof shim.getEnvironmentData).toBe("function");
  });

  it("worker context: isMainThread false, workerData + parentPort from host", async () => {
    const posted: unknown[] = [];
    const { createHostPort } = await import("../src/worker_threads.ts");
    const { port, deliver } = createHostPort((v) => posted.push(v));
    const shim = createWorkerThreadsShim({
      context: { workerData: { n: 7 }, parentPort: port, threadId: 3 },
    });
    expect(shim.isMainThread).toBe(false);
    expect(shim.workerData).toEqual({ n: 7 });
    expect(shim.threadId).toBe(3);
    (shim.parentPort as { postMessage(v: unknown): void }).postMessage("up");
    expect(posted).toEqual(["up"]);
    const got: unknown[] = [];
    (shim.parentPort as { on(e: string, f: (v: unknown) => void): void }).on("message", (v) =>
      got.push(v),
    );
    deliver("down");
    expect(got).toEqual(["down"]);
  });

  it("spawned worker echoes workerData back over postMessage", async () => {
    const { spawner, spawned } = evalSpawner();
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker(`parentPort.postMessage(workerData * 2)`, {
      eval: true,
      workerData: 21,
    });
    const message = await new Promise((resolve) => worker.on("message", resolve));
    expect(message).toBe(42);
    const code = await new Promise((resolve) => worker.on("exit", resolve));
    expect(code).toBe(0);
    expect(worker.threadId).toBe(1);
    expect(spawned[0].spec.workerData).toBe(21);
  });

  it("routes postMessage into the worker and its reply back", async () => {
    const { spawner } = evalSpawner();
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker(
      `parentPort.on("message", (v) => parentPort.postMessage("pong:" + v))`,
      { eval: true },
    );
    const reply = new Promise((resolve) => worker.on("message", resolve));
    worker.postMessage("ping");
    expect(await reply).toBe("pong:ping");
  });

  it("terminate() resolves the exit code and emits 'exit'", async () => {
    // A worker that never exits on its own.
    const hanging: WorkerThreadHandle = {
      postMessage: () => {},
      terminate: () => {},
      setOnMessage: () => {},
      setOnError: () => {},
      setOnExit: () => {},
    };
    const shim = createWorkerThreadsShim({ spawnWorker: () => hanging });
    const worker = new shim.Worker(`for (;;) {}`, { eval: true });
    const exit = new Promise((resolve) => worker.on("exit", resolve));
    const code = await worker.terminate();
    expect(code).toBe(1);
    expect(await exit).toBe(1);
  });

  it("emits 'error' when the spawned code throws", async () => {
    const { spawner } = evalSpawner();
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker(`throw new Error("boom")`, { eval: true });
    const err = await new Promise<Error>((resolve) => worker.on("error", resolve));
    expect(err.message).toBe("boom");
  });

  it("emits 'error' + 'exit' when no spawner is available", async () => {
    const shim = createWorkerThreadsShim({ spawnWorker: () => undefined });
    const worker = new shim.Worker("./missing.js");
    const err = await new Promise<Error>((resolve) => worker.on("error", resolve));
    expect(err.message).toMatch(/no spawnWorker/);
    const code = await new Promise((resolve) => worker.on("exit", resolve));
    expect(code).toBe(1);
  });

  it("MessageChannel ports exchange messages", async () => {
    const shim = createWorkerThreadsShim();
    const { port1, port2 } = new shim.MessageChannel();
    const got = new Promise((resolve) => port2.on("message", resolve));
    port1.postMessage({ hello: "world" });
    expect(await got).toEqual({ hello: "world" });
  });

  it("receiveMessageOnPort returns {message} or undefined", async () => {
    const shim = createWorkerThreadsShim();
    const { port1, port2 } = new shim.MessageChannel();
    expect(shim.receiveMessageOnPort(port2)).toBeUndefined();
    port1.postMessage("a");
    await nextTick();
    expect(shim.receiveMessageOnPort(port2)).toEqual({ message: "a" });
    expect(shim.receiveMessageOnPort(port2)).toBeUndefined();
  });

  it("markAsUncloneable blocks postMessage; markAsUntransferable blocks transfer", () => {
    const shim = createWorkerThreadsShim();
    const { port1 } = new shim.MessageChannel();
    const obj = { secret: true };
    shim.markAsUncloneable(obj);
    expect(() => port1.postMessage(obj)).toThrow(/could not be cloned/i);
    const buf = new ArrayBuffer(8);
    shim.markAsUntransferable(buf);
    expect(shim.isMarkedAsUntransferable(buf)).toBe(true);
    expect(() => port1.postMessage("x", [buf])).toThrow(/untransferable/i);
  });

  it("setEnvironmentData/getEnvironmentData round-trip", () => {
    const shim = createWorkerThreadsShim();
    const key = Symbol("k");
    shim.setEnvironmentData(key, 42);
    expect(shim.getEnvironmentData(key)).toBe(42);
  });

  it("ref/unref report handle state", () => {
    const { spawner } = evalSpawner();
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker("", { eval: true });
    expect(worker.hasRef()).toBe(true);
    worker.unref();
    expect(worker.hasRef()).toBe(false);
    worker.ref();
    expect(worker.hasRef()).toBe(true);
  });
});

describe("worker_threads: MessagePort/MessageChannel construction semantics", () => {
  it("MessagePort cannot be constructed directly (ERR_CONSTRUCT_CALL_INVALID)", () => {
    const shim = createWorkerThreadsShim();
    expect(() => new shim.MessagePort(undefined as never)).toThrow(
      expect.objectContaining({ code: "ERR_CONSTRUCT_CALL_INVALID", name: "TypeError" }),
    );
  });

  it("MessageChannel requires new (ERR_CONSTRUCT_CALL_REQUIRED)", () => {
    const shim = createWorkerThreadsShim();
    const { MessageChannel } = shim;
    expect(() => (MessageChannel as unknown as () => unknown)()).toThrow(
      expect.objectContaining({ code: "ERR_CONSTRUCT_CALL_REQUIRED", name: "TypeError" }),
    );
  });

  it("MessageChannel ports are MessagePort instances with constructor fidelity", () => {
    const shim = createWorkerThreadsShim();
    const { port1, port2 } = new shim.MessageChannel();
    expect(port1 instanceof shim.MessagePort).toBe(true);
    expect(port1.constructor).toBe(shim.MessagePort);
    expect(port2.constructor).toBe(shim.MessagePort);
  });
});

describe("worker_threads: exit event", () => {
  it("emits 'exit' when the thread reports a normal exit and exceptions in the handler surface as 'error'", async () => {
    const { spawner } = evalSpawner();
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker("parentPort.postMessage('done')", { eval: true });
    const exitCode = await new Promise<number>((resolve) => worker.on("exit", resolve));
    expect(exitCode).toBe(0);
  });

  it("'exit' fires with code 1 after an uncaught thread error", async () => {
    let onError: ((e: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    const spawner = (): WorkerThreadHandle => ({
      postMessage: () => {},
      terminate: () => {},
      setOnMessage: () => {},
      setOnError: (cb) => {
        onError = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
    });
    const shim = createWorkerThreadsShim({ spawnWorker: spawner });
    const worker = new shim.Worker(`throw new Error("foo")`, { eval: true });
    const codes: number[] = [];
    worker.on("exit", (code: number) => codes.push(code));
    const errors: unknown[] = [];
    worker.on("error", (err: unknown) => errors.push(err));
    await nextTick();
    onError?.(new Error("foo"));
    await nextTick();
    expect(errors.length).toBe(1);
    expect(codes).toEqual([1]);
  });
});
