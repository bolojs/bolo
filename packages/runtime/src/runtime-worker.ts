import type { VfsBus } from "@browser-containers/vfs-bus";
import type { SWSandbox } from "@browser-containers/sw-sandbox";

export interface RunScriptOptions {
  filename?: string;
  args?: string[];
  httpShimOptions?: { onPortEvent?: (event: string, data: { port: number; url?: string }) => void };
}

export type RuntimeMessage =
  | { type: "RUN_SCRIPT"; code: string; opts: RunScriptOptions }
  | { type: "STDOUT"; data: string }
  | { type: "STDERR"; data: string }
  | { type: "EXIT"; code: number }
  | { type: "HEARTBEAT" };

export class RuntimeWorker {
  private worker: Worker | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private missedHeartbeats = 0;
  onStdout: ((data: string) => void) | null = null;
  onStderr: ((data: string) => void) | null = null;
  onExit: ((code: number) => void) | null = null;

  constructor(
    private vfs: VfsBus,
    private sandbox: SWSandbox,
  ) {}

  async runScript(code: string, opts: RunScriptOptions = {}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.rejectRun = reject;
      this.worker = new Worker(new URL("./worker-script.js", import.meta.url), { type: "module" });
      this.worker.onerror = (e) => {
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

  private rejectRun: ((reason?: Error) => void) | null = null;

  private startWatchdog = (): void => {
    const check = () => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > 1) {
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
  };
}
