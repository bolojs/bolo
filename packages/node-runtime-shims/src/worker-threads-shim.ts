import {
  createWorkerThreadsShim,
  createHostPort,
  type WorkerThreadSpawner,
  type ShimMessagePort,
} from "@bolojs/node-web-shims";

/**
 * Container-side backend for `node:worker_threads`.
 *
 * Worker-per-process model: a thread is a spawned process worker (bundled
 * code + full shim registry over remote deps), so `require("worker_threads")`
 * inside the thread gets its own registry whose `workerThread` context makes
 * `isMainThread === false` and `parentPort`/`workerData` real.
 *
 * The host injects `spawnProcess` — the same seam `child_process.fork` uses —
 * which knows how to reach a Worker (in a process worker: an rpc `thread.*`
 * op back to the main thread; on the main thread: a NodeProcess directly).
 */

/** What the host can spawn: a bundled file (`filename`), or raw `code`. */
export interface ProcessSpawnSpec {
  readonly filename?: string;
  readonly code?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly workerData?: unknown;
  /** Parent-assigned worker_threads threadId. */
  readonly threadId?: number;
}

/**
 * Live handle to a spawned process. Message flow is raw: `postMessage`
 * delivers to the child's `parentPort`/`process` IPC surface; `setOnMessage`
 * receives anything the child posted up (parentPort messages and
 * `process.send` envelopes — the child_process adapter re-envelopes).
 */
export interface SpawnedProcess {
  postMessage(value: unknown): void;
  terminate(): void;
  setOnStdout(cb: ((data: string) => void) | null): void;
  setOnStderr(cb: ((data: string) => void) | null): void;
  setOnMessage(cb: ((value: unknown) => void) | null): void;
  setOnExit(cb: ((code: number) => void) | null): void;
  setOnError(cb: ((error: unknown) => void) | null): void;
}

export type ProcessSpawner = (spec: ProcessSpawnSpec) => SpawnedProcess | undefined;

/** Thread context for a registry living INSIDE a spawned worker. */
export interface WorkerThreadInfo {
  readonly workerData?: unknown;
  readonly parentPort?: unknown;
  readonly threadId?: number;
}

export interface WorkerThreadsBackendDeps {
  readonly spawnProcess?: ProcessSpawner;
  readonly thread?: WorkerThreadInfo;
  /** Worker stdout/stderr ride the parent's streams, as in Node. */
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
}

export const createWorkerThreadsBackend = (deps: WorkerThreadsBackendDeps = {}) => {
  const spawnWorker: WorkerThreadSpawner | undefined = deps.spawnProcess
    ? (spec) => {
        const proc = deps.spawnProcess!({
          filename: spec.filename,
          code: spec.code,
          args: spec.args,
          env: spec.env,
          workerData: spec.workerData,
          threadId: spec.threadId,
        });
        if (!proc) return undefined;
        proc.setOnStdout(deps.onStdout ?? null);
        proc.setOnStderr(deps.onStderr ?? null);
        return {
          postMessage: (v: unknown) => proc.postMessage(v),
          terminate: () => proc.terminate(),
          setOnMessage: (cb) => proc.setOnMessage(cb),
          setOnError: (cb) => proc.setOnError(cb),
          setOnExit: (cb) => proc.setOnExit(cb),
        };
      }
    : undefined;

  return createWorkerThreadsShim({
    spawnWorker,
    context: deps.thread
      ? {
          workerData: deps.thread.workerData,
          parentPort: deps.thread.parentPort,
          threadId: deps.thread.threadId,
        }
      : undefined,
  });
};

/**
 * Bridge for hosts running a thread: `post` ships parentPort.postMessage
 * payloads toward the parent realm; feed inbound values to `deliver`. The
 * `port` is passed as `workerThread.parentPort` to the registry.
 */
export const createParentPortBridge = createHostPort;
export type { ShimMessagePort };

/**
 * Adapt a `SpawnedProcess` to the `WorkerLike` protocol `child_process`
 * expects (`{stream}|{type:'exit'|'IPC_*'}` envelopes over onmessage).
 */
export const spawnedProcessToWorkerLike = (
  proc: SpawnedProcess,
): {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
} => {
  const workerLike = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { error?: unknown }) => void) | null,
    postMessage: (message: unknown) => proc.postMessage(message),
    terminate: () => proc.terminate(),
  };
  proc.setOnStdout((data) => workerLike.onmessage?.({ data: { stream: "stdout", data } }));
  proc.setOnStderr((data) => workerLike.onmessage?.({ data: { stream: "stderr", data } }));
  proc.setOnExit((code) => workerLike.onmessage?.({ data: { type: "exit", code } }));
  proc.setOnError((error) => workerLike.onerror?.({ error }));
  proc.setOnMessage((value) => {
    // IPC envelopes (`process.send`/`disconnect` from the child) pass through;
    // anything else is a thread message — report it as one IPC message.
    const isEnvelope =
      typeof value === "object" &&
      value !== null &&
      ((value as { type?: string }).type === "IPC_MESSAGE" ||
        (value as { type?: string }).type === "IPC_DISCONNECT");
    workerLike.onmessage?.({
      data: isEnvelope ? value : { type: "IPC_MESSAGE", data: value },
    });
  });
  return workerLike;
};
