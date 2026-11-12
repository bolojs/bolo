import { configureBrowserLogging, getLogger } from "@bolojs/log/browser";
import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import {
  createLiveShimRegistry,
  createParentPortBridge,
  ProcessExit,
} from "@bolojs/node-runtime-shims";
import type { ProcessShim, SpawnedProcess } from "@bolojs/node-runtime-shims";
import { createRpcPeer } from "./rpc.js";
import { createRemoteDeps } from "./remote-objects.js";
import { createSyncCaller } from "./sync-channel.js";
import { createNodeTimers } from "./node-timers.js";
import { createEventLoop } from "./event-loop.js";
import {
  AsyncLocalStorage,
  emitInit,
  reserveAsyncId,
  runInAsyncScope,
  instrumentPromises,
} from "@bolojs/node-web-shims/dist/async_hooks.js";
import { trackEventTargetListeners } from "@bolojs/node-web-shims/dist/events.js";

// ponytail: see worker-script.ts — fire-and-forget to stay TLA-free.
configureBrowserLogging().catch(() => {});
const logger = getLogger(["bolo", "runtime", "node-process-worker"]);

/**
 * Process worker: one dedicated Worker per spawned node process. Receives the
 * bundled entry (built on the main thread by `bundleEntry`), materializes a
 * live shim registry bound to remote deps (VfsBus/SWSandbox over RPC + the
 * sync channel), then imports the bundle as a blob module in this realm.
 *
 * Termination semantics live here, not on the main thread: `process.exit`
 * throws ProcessExit → EXIT with its code; an uncaught error or unhandled
 * rejection → Node-formatted stderr + exit 1 unless the process registered
 * handlers; natural completion fires `beforeExit`/`exit` once the tracked
 * timers drain (bounded by a quiescence cap, or skipped while a server is
 * listening — the handle table in step 4 replaces this heuristic).
 * `kill()` on the main side simply terminates the Worker, which reclaims
 * even a synchronous infinite loop.
 */

export interface ProcRunMessage {
  type: "PROC_RUN";
  pid: string;
  code: string;
  filename: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  xhrUrl: string;
  hasSandbox: boolean;
  hasShellService: boolean;
  hasWasmRegistry: boolean;
  sab?: SharedArrayBuffer;
  quiescenceCapMs?: number;
  /** Present when this process runs a worker_threads thread. */
  thread?: { workerData?: unknown; threadId?: number };
}

export type ProcWorkerMessage =
  | { type: "STDOUT"; data: string }
  | { type: "STDERR"; data: string }
  | { type: "EXIT"; code: number }
  | { type: "PORT_EVENT"; event: string; data: { port: number; url?: string } }
  | { type: "THREAD_MSG"; data: unknown }
  | { type: "HEARTBEAT" };

declare global {
  // eslint-disable-next-line no-var
  var __browserContainers:
    | {
        vfs: VfsBus;
        sandbox?: SWSandbox;
        shims: Record<string, unknown>;
        timers?: {
          setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
          clearTimeout: (t: unknown) => unknown;
          setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
          clearInterval: (t: unknown) => unknown;
          setImmediate?: (fn: (...a: unknown[]) => void, ...rest: unknown[]) => unknown;
          clearImmediate?: (t: unknown) => unknown;
        };
      }
    | undefined;
}

const post = (msg: ProcWorkerMessage | unknown) => (self as unknown as Worker).postMessage(msg);

const formatUncaught = (err: unknown, version: string): string => {
  const body = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `Uncaught ${body}\n\nNode.js ${version}\n`;
};

setInterval(() => {
  post({ type: "HEARTBEAT" });
}, 5000);

let processShim: ProcessShim | null = null;
let exited = false;
/** Fatal uncaught error: Node prints it, runs 'exit' handlers with code 1, then exits 1. */
const crash = (err: unknown) => {
  post({ type: "STDERR", data: formatUncaught(err, "v22.0.0") });
  if (processShim) {
    processShim.exitCode = 1;
    try {
      processShim.emit("exit", 1);
    } catch {
      /* exit handlers must not mask the crash */
    }
  }
  // Exit handlers may overwrite process.exitCode (Node honours it).
  finish(processShim?.exitCode ?? 1);
};
const finish = (code: number) => {
  if (exited) return;
  exited = true;
  post({ type: "EXIT", code });
};

// Uncaught errors inside the worker realm: hand to the process's
// 'uncaughtException' listeners when present, else Node-formatted exit 1.
const handleUncaught = (err: unknown): boolean => {
  if (exited) return true;
  if (err instanceof ProcessExit) {
    finish(err.code);
    return true;
  }
  if (
    processShim &&
    (processShim.listenerCount("uncaughtException") > 0 ||
      processShim.hasUncaughtExceptionCaptureCallback())
  ) {
    processShim.emit("uncaughtException", err, "uncaughtException");
    return true;
  }
  crash(err);
  return true;
};
self.addEventListener("error", (ev: ErrorEvent) => {
  if (exited) return;
  handleUncaught(ev.error ?? ev.message);
  ev.preventDefault();
});

self.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  if (exited) return;
  const reason = ev.reason;
  if (reason instanceof ProcessExit) {
    finish(reason.code);
    return;
  }
  // createLiveShimRegistry installs its own unhandledrejection hook that
  // emits on the process shim; only crash when nobody is listening.
  if (processShim && processShim.listenerCount("unhandledRejection") > 0) return;
  crash(reason);
});

const runProcess = async (msg: ProcRunMessage) => {
  const rpc = createRpcPeer((m) => post(m));
  // Promise continuations announce an async resource so async_hooks
  // init/before/after/promiseResolve fire around them (Node parity).
  instrumentPromises();
  // Track EventTarget listeners so events.getEventListeners() can report
  // them (unenv's implementation reads a private symbol that does not exist).
  trackEventTargetListeners();

  // worker_threads: a thread is a spawned process worker. `spawnProcess`
  // asks the main thread for one over rpc (`thread.*` ops — main bundles the
  // file, spawns the NodeProcess, and relays messages both ways). Message
  // values cross as rpc args: structured-clone fidelity minus transferables.
  const spawnProcess = (spec: {
    filename?: string;
    code?: string;
    args?: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    workerData?: unknown;
    threadId?: number;
  }): SpawnedProcess | undefined => {
    let onMessage: ((v: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    let onError: ((e: unknown) => void) | null = null;
    let onStdout: ((d: string) => void) | null = null;
    let onStderr: ((d: string) => void) | null = null;
    const idP = rpc
      .call<number>(
        "thread.spawn",
        spec,
        (v: unknown) => onMessage?.(v),
        (c: number) => onExit?.(c),
        (d: string) => onStdout?.(d),
        (d: string) => onStderr?.(d),
      )
      .catch((err) => {
        onError?.(err);
        return -1;
      });
    return {
      postMessage: (v) => {
        void idP.then((id) => id >= 0 && rpc.call("thread.send", id, v));
      },
      terminate: () => {
        void idP.then((id) => id >= 0 && rpc.call("thread.terminate", id));
      },
      setOnStdout: (cb) => {
        onStdout = cb;
      },
      setOnStderr: (cb) => {
        onStderr = cb;
      },
      setOnMessage: (cb) => {
        onMessage = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
      setOnError: (cb) => {
        onError = cb;
      },
    };
  };

  const thread = msg.thread
    ? createParentPortBridge((v) => post({ type: "THREAD_MSG", data: v }))
    : undefined;
  const caller = createSyncCaller({
    pid: msg.pid,
    xhrUrl: msg.xhrUrl,
    sab: msg.sab,
    postMessage: (m, _transfer) => post(m),
    timeoutMs: 30000,
  });
  void caller;

  const remote = createRemoteDeps({
    rpc,
    syncCaller: caller,
    hasSandbox: msg.hasSandbox,
    hasWasmRegistry: msg.hasWasmRegistry,
    hasShellService: msg.hasShellService,
  });

  const shims = createLiveShimRegistry({
    vfs: remote.vfs,
    sandbox: remote.sandbox,
    wasmRegistry: remote.wasmRegistry as never,
    shellService: remote.shellService as never,
    cwd: msg.cwd,
    argv: ["node", msg.filename, ...msg.args],
    onStdout: (data) => post({ type: "STDOUT", data }),
    onStderr: (data) => post({ type: "STDERR", data }),
    onPortEvent: (event, data) => post({ type: "PORT_EVENT", event, data }),
    spawnProcess,
    workerThread: thread
      ? {
          workerData: msg.thread!.workerData,
          parentPort: thread.port,
          threadId: msg.thread!.threadId,
        }
      : undefined,
  });
  processShim = shims.process as ProcessShim;
  const nextTick = processShim.nextTick;
  processShim.nextTick = ((fn: unknown, ...args: unknown[]) => {
    if (typeof fn !== "function") return nextTick(fn as never, ...args);
    // Capture the async context (AsyncLocalStorage store) and announce the
    // async resource, so async_hooks sees 'init'/'before'/'after' around the
    // callback like Node does.
    const run = AsyncLocalStorage.snapshot();
    // Node does not report nextTick through 'init', only through
    // before/after — so reserve an id instead of announcing a resource.
    const asyncId = reserveAsyncId();
    return nextTick(
      (...cbArgs: unknown[]) =>
        runInAsyncScope(asyncId, () => Reflect.apply(fn, undefined, cbArgs)) as unknown,
      ...args,
    );
  }) as ProcessShim["nextTick"];
  // child_process.fork IPC: `process.send`/`process.on('message')` ride the
  // same THREAD_MSG transport as parentPort, wrapped in IPC envelopes.
  const ipcProcess = processShim as ProcessShim & {
    send?: (m: unknown) => boolean;
    disconnect?: () => void;
  };
  ipcProcess.send = (m: unknown) => {
    post({ type: "THREAD_MSG", data: { type: "IPC_MESSAGE", data: m } });
    return true;
  };
  ipcProcess.disconnect = () => {
    post({ type: "THREAD_MSG", data: { type: "IPC_DISCONNECT" } });
    processShim.emit("disconnect");
  };
  // process.exit must be uncatchable (Node semantics): run the shim's exit
  // handlers, tell the host, then stall until the host terminates this worker.
  const shimExit = processShim.exit;
  processShim.exit = ((code?: number) => {
    try {
      shimExit(code);
    } catch (err) {
      if (!(err instanceof ProcessExit)) throw err;
      finish(err.code);
    }
    for (;;) {
      /* host terminates the worker on EXIT */
    }
  }) as typeof processShim.exit;
  globalThis.__browserContainers = {
    vfs: remote.vfs,
    sandbox: remote.sandbox,
    shims,
  };

  // Route worker-realm rpc-* and thread/IPC messages arriving while running.
  self.addEventListener("message", (ev: MessageEvent) => {
    if (rpc.handle(ev.data)) return;
    const msg = ev.data as { type?: string; data?: unknown } | null;
    if (msg?.type === "THREAD_MSG") {
      const data = msg.data as { type?: string; data?: unknown } | null;
      if (data?.type === "IPC_MESSAGE") processShim?.emit("message", data.data);
      else if (data?.type === "IPC_DISCONNECT") processShim?.emit("disconnect");
      else thread?.deliver(data);
    }
  });

  // Node-style event loop owned by the worker (event-loop.ts) schedules and owns
  // ordering/liveness; node-timers.ts layers the public Timeout/Immediate API on
  // top, backed by loop handles. Injected into the bundle's globals via
  // `__browserContainers.timers` (GLOBALS_BANNER) and the `node:timers` shim;
  // infrastructure timers (logtape, rpc) use the realm's real globals and never
  // count as handles.
  const loop = createEventLoop({
    drainTicks: () => processShim?.drainTicks(),
    onUncaught: handleUncaught,
    isExited: () => exited,
  });
  const { timers: trackedTimers, promises: timerPromises } = createNodeTimers({
    setTimer: (fn, ms) => loop.setTimeout(fn, ms),
    clearTimer: (h) => loop.clearTimeout(h),
    setImmediate: (fn) => loop.setImmediate(fn),
    clearImmediate: (h) => loop.clearImmediate(h),
    warn: (name, message) => {
      const warning = Object.assign(new Error(message), { name });
      processShim?.emit("warning", warning);
    },
  });
  globalThis.__browserContainers!.timers = trackedTimers;
  // `require('node:timers')` sees the same implementation.
  const timersShim = shims.timers as Record<string, unknown> | undefined;
  shims.timers = { ...timersShim, ...trackedTimers, promises: timerPromises };
  shims["timers/promises"] = timerPromises;

  const hasRefedTimers = () => loop.hasRefed();
  const origSet = globalThis.setTimeout.bind(globalThis);

  const sleep = (ms: number) => new Promise<void>((r) => origSet(r, ms));
  // A registered fetch handler means a server is listening — a live handle
  // that keeps the process alive past top-level completion.
  const serving = () => remote.fetchHandlerCount() > 0;

  let explicitExit: number | undefined;
  let fatal: unknown;
  try {
    const blob = new Blob([msg.code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const mod = (await import(/* @vite-ignore */ url)) as {
      default?: { fetch?: (req: Request) => Promise<Response> };
    };
    // Workers-style default export with .fetch → auto-register (same as the
    // main-thread path in ShellService.runNodeApp).
    const exportedApp = mod?.default;
    if (exportedApp && typeof exportedApp.fetch === "function" && remote.sandbox) {
      remote.sandbox.onFetch(exportedApp.fetch.bind(exportedApp));
      post({
        type: "PORT_EVENT",
        event: "server-ready",
        data: { port: 3000, url: "https://sandbox.local" },
      });
      post({
        type: "PORT_EVENT",
        event: "port-open",
        data: { port: 3000, url: "https://sandbox.local" },
      });
    }
  } catch (err) {
    if (err instanceof ProcessExit) {
      explicitExit = err.code;
    } else {
      fatal = err;
    }
  }

  if (fatal !== undefined) {
    if (processShim.listenerCount("uncaughtException") > 0) {
      processShim.emit("uncaughtException", fatal, "uncaughtException");
    } else {
      crash(fatal);
      return;
    }
  }

  if (explicitExit !== undefined) {
    finish(explicitExit);
    return;
  }

  // Event-loop liveness: keep running while refed handles exist. A serving
  // server or a live interval keeps the process alive indefinitely (matches
  // Node — kill() is the reclaim, not a quiescence cap). beforeExit may
  // itself schedule work, so it re-enters the drain loop.
  await loop.yieldTask();
  for (;;) {
    await loop.run();
    // Grace period: unhandledrejection events and just-posted messages are
    // delivered as tasks after the last timer; quiescence must not race them.
    await sleep(10);
    if (exited) return;
    if (hasRefedTimers()) continue;
    // A listening server keeps the process alive indefinitely — the worker
    // must not emit exit (main would terminate it and kill the server).
    if (serving()) {
      await new Promise<void>(() => {});
    }
    try {
      processShim.emit("beforeExit", processShim.exitCode ?? 0);
    } catch (err) {
      if (err instanceof ProcessExit) finish(err.code);
      else crash(err);
      return;
    }
    // beforeExit scheduled new work — drain again before exiting.
    if (hasRefedTimers()) continue;
    break;
  }

  if (exited) return;
  try {
    processShim.emit("exit", processShim.exitCode ?? 0);
  } catch (err) {
    finish(err instanceof ProcessExit ? err.code : 1);
    return;
  }
  finish(processShim.exitCode ?? 0);
};

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { type?: string };
  if (msg?.type === "PROC_RUN") {
    void runProcess(msg as ProcRunMessage).catch((err) => {
      logger.error("process worker failed", { error: String(err) });
      post({ type: "STDERR", data: formatUncaught(err, "v22.0.0") });
      finish(1);
    });
  }
};
