import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import type { WasmRegistry, ShellService } from "@bolojs/node-runtime-shims";
import { getLogger } from "@bolojs/log/browser";
import { createRpcPeer, decodeOpCall, encodeOpResult, marshalError } from "./rpc.js";
import type { RpcPeer } from "./rpc.js";
import { createProcessOps } from "./remote-ops.js";
import type { OpDispatch } from "./remote-ops.js";
import { createSyncBuffer } from "./sync-channel.js";
import type { SyncServer } from "./sync-channel.js";
import type { ProcRunMessage, ProcWorkerMessage } from "./node-process-worker.js";

const logger = getLogger(["bolo", "runtime", "node-process"]);

/**
 * Main-side handle for one process worker. Owns the Worker, the rpc peer,
 * the op dispatch (vfs/sandbox/wasm/shell over the remote ops table), the
 * sync-channel registration, and the liveness watchdog. `kill()` terminates
 * the worker — a real reclaim, including synchronous infinite loops.
 */

export interface NodeProcessDeps {
  readonly pid: string;
  readonly vfs: VfsBus;
  readonly sandbox?: SWSandbox;
  readonly syncServer: SyncServer;
  /** Absolute URL path of the XHR sync endpoint (`<scope>__bolo_sync/<pid>`). */
  readonly xhrUrl: string;
  readonly wasmRegistry?: WasmRegistry;
  readonly shellService?: ShellService;
  readonly quiescenceCapMs?: number;
  /** SharedArrayBuffer size for the sync channel; 0 disables the SAB path. */
  readonly sabBytes?: number;
  /**
   * Spawn a worker thread / forked child as a sibling process worker.
   * Routed to the `thread.*` ops so code inside this process can call
   * `new Worker(...)` / `child_process.fork(...)`. Threads spawned here are
   * terminated when this process exits.
   */
  readonly spawnThread?: (
    spec: {
      filename?: string;
      code?: string;
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      workerData?: unknown;
      threadId?: number;
    },
    onMessage: (value: unknown) => void,
    onExit: (code: number) => void,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void,
  ) => Promise<{ post(value: unknown): void; terminate(): void }>;
}

export interface NodeProcessRunOptions {
  code: string;
  filename: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Present when this process runs a worker_threads thread. */
  thread?: { workerData?: unknown; threadId?: number };
}

export interface NodeProcessCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
}

const WATCHDOG_MS = 5000;
const MAX_MISSED_HEARTBEATS = 2;

export class NodeProcess {
  private worker: Worker | null = null;
  private rpc: RpcPeer | null = null;
  private dispatch: OpDispatch;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  private exited = false;
  private killed = false;

  onStdout: ((data: string) => void) | null = null;
  onStderr: ((data: string) => void) | null = null;
  onPortEvent: ((event: string, data: { port: number; url?: string }) => void) | null = null;
  /** Values the process posts up via `parentPort.postMessage`/`process.send`. */
  onThreadMessage: ((value: unknown) => void) | null = null;

  /** Threads this process spawned via the `thread.*` ops — killed on exit. */
  private readonly spawnedThreads = new Set<{ terminate(): void }>();

  readonly exit: Promise<number>;

  private resolveExit!: (code: number) => void;

  constructor(private deps: NodeProcessDeps) {
    this.exit = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    this.dispatch = createProcessOps({
      vfs: deps.vfs,
      sandbox: deps.sandbox,
      wasmRegistry: deps.wasmRegistry,
      shellService: deps.shellService,
      threads: deps.spawnThread
        ? {
            spawn: async (spec, onMessage, onExit, onStdout, onStderr) => {
              const handle = await deps.spawnThread!(spec, onMessage, onExit, onStdout, onStderr);
              this.spawnedThreads.add(handle);
              return {
                post: (v) => handle.post(v),
                terminate: () => {
                  this.spawnedThreads.delete(handle);
                  handle.terminate();
                },
              };
            },
          }
        : undefined,
    });
  }

  run(opts: NodeProcessRunOptions): void {
    const { deps } = this;

    // SAB only when the page is cross-origin isolated; otherwise the worker
    // falls back to sync XHR for its synchronous syscalls.
    const sab =
      (deps.sabBytes ?? 0) > 0 && typeof SharedArrayBuffer !== "undefined"
        ? createSyncBuffer(deps.sabBytes)
        : undefined;

    this.deps.syncServer.attach(
      deps.pid,
      async (payload) => {
        const { op, args } = decodeOpCall(payload);
        try {
          return encodeOpResult(true, await this.dispatch(op, args));
        } catch (err) {
          return encodeOpResult(false, marshalError(err));
        }
      },
      { sab },
    );

    const worker = new Worker(new URL("./node-process-worker.js", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    const rpc = createRpcPeer((m) => worker.postMessage(m));
    this.rpc = rpc;
    rpc.serveAny = (op, args) => this.dispatch(op, args);

    worker.onerror = (e) => {
      logger.error("process worker error", { pid: deps.pid, message: e.message });
      e.preventDefault();
      this.finish(1);
    };
    worker.onmessage = ({ data }: MessageEvent) => {
      if (this.deps.syncServer.handleWorkerMessage(deps.pid, data)) return;
      if (rpc.handle(data)) return;
      const msg = data as ProcWorkerMessage;
      switch (msg.type) {
        case "STDOUT":
          return this.onStdout?.(msg.data);
        case "STDERR":
          return this.onStderr?.(msg.data);
        case "PORT_EVENT":
          return this.onPortEvent?.(msg.event, msg.data);
        case "THREAD_MSG":
          return this.onThreadMessage?.(msg.data);
        case "HEARTBEAT":
          this.missedHeartbeats = 0;
          return;
        case "EXIT":
          return this.finish(msg.code);
      }
    };

    const run: ProcRunMessage = {
      type: "PROC_RUN",
      pid: deps.pid,
      code: opts.code,
      filename: opts.filename,
      args: opts.args ?? [],
      env: opts.env,
      cwd: opts.cwd,
      xhrUrl: deps.xhrUrl,
      hasSandbox: deps.sandbox !== undefined,
      hasShellService: deps.shellService !== undefined,
      hasWasmRegistry: deps.wasmRegistry !== undefined,
      sab,
      quiescenceCapMs: deps.quiescenceCapMs,
      thread: opts.thread,
    };
    worker.postMessage(run);
    this.startWatchdog();
  }

  /** Deliver a value to the process's `parentPort`/IPC (`worker.postMessage`
   * in worker_threads terms). */
  postToThread(value: unknown): void {
    this.worker?.postMessage({ type: "THREAD_MSG", data: value });
  }

  /** Terminate the worker. Resolves exit as 1 (SIGKILL has no numeric code in
   * this API; callers that need signal semantics can wrap). */
  kill(): void {
    this.killed = true;
    this.finish(1);
  }

  private startWatchdog(): void {
    const check = () => {
      if (this.exited) return;
      this.missedHeartbeats++;
      if (this.missedHeartbeats > MAX_MISSED_HEARTBEATS) {
        logger.error("process worker missed heartbeats; terminating", { pid: this.deps.pid });
        this.finish(1);
        return;
      }
      this.heartbeatTimer = setTimeout(check, WATCHDOG_MS);
    };
    this.heartbeatTimer = setTimeout(check, WATCHDOG_MS);
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const handle of this.spawnedThreads) {
      try {
        handle.terminate();
      } catch {
        /* a dead thread must not block teardown */
      }
    }
    this.spawnedThreads.clear();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.worker?.terminate();
    this.worker = null;
    this.rpc?.reset(new Error(this.killed ? "process killed" : `process exited with code ${code}`));
    this.deps.syncServer.detach(this.deps.pid);
    this.resolveExit(code);
  }
}
