import type { VfsBus } from "@bolojs/vfs-bus";
import type { SWSandbox } from "@bolojs/sw-sandbox";
import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "runtime", "runtime-worker"]);

export interface RunScriptOptions {
  filename?: string;
  args?: string[];
  httpShimOptions?: { onPortEvent?: (event: string, data: { port: number; url?: string }) => void };
}

export interface ReplResult {
  ok: boolean;
  value?: string;
  error?: string;
  continuation?: boolean;
}

export type RuntimeMessage =
  | { type: "RUN_SCRIPT"; code: string; opts: RunScriptOptions }
  | { type: "STDOUT"; data: string }
  | { type: "STDERR"; data: string }
  | { type: "EXIT"; code: number }
  | { type: "HEARTBEAT" }
  | { type: "IPC_MESSAGE"; data: unknown }
  | { type: "IPC_DISCONNECT" }
  | { type: "REPL_START" }
  | { type: "REPL_EVAL"; id: string; code: string }
  | {
      type: "REPL_RESULT";
      id: string;
      ok: boolean;
      value?: string;
      error?: string;
      continuation?: boolean;
    }
  | { type: "REPL_EXIT" };

const generateId = (): string => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export class RuntimeWorker {
  private worker: Worker | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  onStdout: ((data: string) => void) | null = null;
  onStderr: ((data: string) => void) | null = null;
  onExit: ((code: number) => void) | null = null;

  private replWorker: Worker | null = null;
  private replCallbacks: Map<
    string,
    {
      resolve: (value: ReplResult | PromiseLike<ReplResult>) => void;
      reject: (reason: Error) => void;
    }
  > = new Map();
  onReplResult?: (result: ReplResult) => void;

  constructor(
    private vfs: VfsBus,
    private sandbox: SWSandbox,
  ) {}

  async runScript(code: string, opts: RunScriptOptions = {}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.rejectRun = reject;
      this.worker = new Worker(new URL("./worker-script.js", import.meta.url), { type: "module" });
      logger.debug("Worker spawned for runScript");
      this.worker.onerror = (e) => {
        logger.error("Worker error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
        });
        reject(new Error(e.message));
        this.dispose();
      };
      this.worker.onmessage = ({ data }: MessageEvent<RuntimeMessage>) => {
        switch (data.type) {
          case "STDOUT":
            return this.onStdout?.(data.data);
          case "STDERR":
            return this.onStderr?.(data.data);
          case "EXIT":
            this.onExit?.(data.code);
            this.dispose();
            return resolve();
          case "HEARTBEAT":
            this.missedHeartbeats = 0;
            return;
        }
      };
      this.worker.postMessage({ type: "RUN_SCRIPT", code, opts } satisfies RuntimeMessage);
      this.startWatchdog();
    });
  }

  startRepl(): void {
    if (this.replWorker) return;
    this.replWorker = new Worker(new URL("./worker-script.js", import.meta.url), {
      type: "module",
    });
    logger.debug("Worker spawned for REPL");
    this.replWorker.onmessage = ({ data }: MessageEvent<RuntimeMessage>) => {
      switch (data.type) {
        case "REPL_RESULT": {
          const { id: _id, type: _type, ...result } = data;
          this.onReplResult?.(result as ReplResult);
          const callbacks = this.replCallbacks.get(data.id);
          if (callbacks) {
            this.replCallbacks.delete(data.id);
            callbacks.resolve(result as ReplResult);
          }
          return;
        }
        case "STDOUT":
          return this.onStdout?.(data.data);
        case "STDERR":
          return this.onStderr?.(data.data);
        case "HEARTBEAT":
          // REPL worker heartbeats are ignored for now; watchdog can be added if needed
          return;
      }
    };
    this.replWorker.postMessage({ type: "REPL_START" } satisfies RuntimeMessage);
  }

  evalRepl(code: string): Promise<ReplResult> {
    return new Promise<ReplResult>((resolve, reject) => {
      if (!this.replWorker) {
        reject(new Error("REPL worker not started"));
        return;
      }
      const id = generateId();
      this.replCallbacks.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.replCallbacks.delete(id);
        logger.error("REPL eval timed out", { id });
        reject(new Error(`REPL eval timed out after 30s for id ${id}`));
      }, 30000);
      const originalResolve = resolve;
      resolve = (value: ReplResult | PromiseLike<ReplResult>) => {
        clearTimeout(timer);
        originalResolve(value);
      };
      const originalReject = reject;
      reject = (reason: Error) => {
        clearTimeout(timer);
        originalReject(reason);
      };
      this.replCallbacks.set(id, { resolve, reject });
      this.replWorker.postMessage({ type: "REPL_EVAL", id, code } satisfies RuntimeMessage);
    });
  }

  disposeRepl(): void {
    this.replWorker?.terminate();
    this.replWorker = null;
    for (const { reject } of this.replCallbacks.values()) {
      reject(new Error("REPL worker disposed"));
    }
    this.replCallbacks.clear();
  }

  private rejectRun: ((reason?: Error) => void) | null = null;

  private startWatchdog = (): void => {
    const check = () => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > 1) {
        logger.error("Worker missed heartbeats; terminating");
        this.worker?.terminate();
        this.onExit?.(1);
        this.rejectRun?.(new Error("Worker missed heartbeats"));
        this.dispose();
        return;
      }
      this.heartbeatTimer = setTimeout(check, 5000);
    };
    this.heartbeatTimer = setTimeout(check, 5000);
  };

  dispose = (): void => {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.worker?.terminate();
    this.worker = null;
    this.rejectRun = null;
    this.disposeRepl();
  };
}
