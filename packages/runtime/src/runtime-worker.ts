import type { VfsBus } from '@browser-containers/vfs-bus';
import type { SWSandbox } from '@browser-containers/sw-sandbox';

export interface RunScriptOptions {
  filename?: string;
  args?: string[];
}

export type RuntimeMessage =
  | { type: 'RUN_SCRIPT'; code: string; opts: RunScriptOptions }
  | { type: 'STDOUT'; data: string }
  | { type: 'STDERR'; data: string }
  | { type: 'EXIT'; code: number }
  | { type: 'HEARTBEAT' };

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
    this.worker = new Worker(new URL('./worker-script.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<RuntimeMessage>) => {
      const msg = ev.data;
      if (msg.type === 'STDOUT') this.onStdout?.(msg.data);
      else if (msg.type === 'STDERR') this.onStderr?.(msg.data);
      else if (msg.type === 'EXIT') {
        this.onExit?.(msg.code);
        this.dispose();
      } else if (msg.type === 'HEARTBEAT') {
        this.missedHeartbeats = 0;
      }
    };
    this.worker.postMessage({ type: 'RUN_SCRIPT', code, opts } satisfies RuntimeMessage);
    this.startWatchdog();
  }

  private startWatchdog = (): void => {
    const check = () => {
      this.missedHeartbeats++;
      if (this.missedHeartbeats > 1) {
        this.worker?.terminate();
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
  };
}
