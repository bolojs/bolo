import { configureBrowserLogging, getLogger } from "@bolojs/log/browser";
import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import { createLiveShimRegistry, ProcessExit } from "@bolojs/node-runtime-shims";
import type { ProcessShim } from "@bolojs/node-runtime-shims";
import { createRpcPeer } from "./rpc.js";
import { createRemoteDeps } from "./remote-objects.js";
import { createSyncCaller } from "./sync-channel.js";
import { createNodeTimers } from "./node-timers.js";

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
}

export type ProcWorkerMessage =
  | { type: "STDOUT"; data: string }
  | { type: "STDERR"; data: string }
  | { type: "EXIT"; code: number }
  | { type: "PORT_EVENT"; event: string; data: { port: number; url?: string } }
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

// Macrotask hop through a MessageChannel: runs after the browser's
// unhandledrejection task, matching Node (rejections precede the check phase).
const channelHop = (() => {
  const c = new MessageChannel();
  const q: Array<() => void> = [];
  c.port1.onmessage = () => q.shift()?.();
  return (f: () => void) => {
    q.push(f);
    c.port2.postMessage(0);
  };
})();

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
  finish(1);
};
const finish = (code: number) => {
  if (exited) return;
  exited = true;
  post({ type: "EXIT", code });
};

// Uncaught errors inside the worker realm: hand to the process's
// 'uncaughtException' listeners when present, else Node-formatted exit 1.
self.addEventListener("error", (ev: ErrorEvent) => {
  if (exited) return;
  const err = ev.error ?? ev.message;
  if (err instanceof ProcessExit) {
    finish(err.code);
    return;
  }
  if (processShim && processShim.listenerCount("uncaughtException") > 0) {
    processShim.emit("uncaughtException", err, "uncaughtException");
    ev.preventDefault();
    return;
  }
  crash(err);
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
  const caller = createSyncCaller({
    pid: msg.pid,
    xhrUrl: msg.xhrUrl,
    sab: msg.sab,
    postMessage: (m, transfer) => post(m),
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
  });
  processShim = shims.process as ProcessShim;
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

  // Route worker-realm rpc-* messages arriving while running.
  self.addEventListener("message", (ev: MessageEvent) => {
    rpc.handle(ev.data);
  });

  // libuv-style handle table (see node-timers.ts): each timer the *program*
  // creates is a ref-counted handle; `unref()` drops it out of liveness.
  // Tracked timers are injected into the bundle's globals via
  // `__browserContainers.timers` (see GLOBALS_BANNER) and into the
  // `node:timers` shim; infrastructure timers (logtape flushers, rpc) use the
  // realm's real globals and never count as handles.
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
  const origSet = g.setTimeout!;
  const origClear = g.clearTimeout!;
  const { timers: trackedTimers, hasRefed: hasRefedTimers } = createNodeTimers({
    setNative: (fn, ms) => origSet(fn, ms),
    clearNative: (id) => origClear(id),
    // Node runs the tick queue right after each macrotask callback, before promise jobs.
    afterCallback: () => processShim?.drainTicks(),
    hop: channelHop,
  });
  globalThis.__browserContainers!.timers = trackedTimers;
  // `require('node:timers')` sees the same tracked implementation.
  const timersShim = shims.timers as Record<string, unknown> | undefined;
  if (timersShim) Object.assign(timersShim, trackedTimers);

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
  await sleep(0);
  for (;;) {
    while (!exited && hasRefedTimers()) {
      await sleep(5);
    }
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
      finish(err instanceof ProcessExit ? err.code : 1);
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
