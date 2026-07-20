import type { VfsBus } from "@bolojs/fs";
import type { RuntimeWorker } from "./runtime-worker.js";

const HISTORY_FILE = "/home/web/.node_repl_history";

export interface ReplServiceOptions {
  vfs: VfsBus;
  runtimeWorker: RuntimeWorker;
}

export interface ReplResult {
  ok: boolean;
  value?: string;
  error?: string;
  continuation?: boolean;
}

export class ReplService {
  private vfs: VfsBus;
  private runtimeWorker: RuntimeWorker;
  private history: string[] = [];

  constructor(options: ReplServiceOptions) {
    this.vfs = options.vfs;
    this.runtimeWorker = options.runtimeWorker;
  }

  async start(): Promise<void> {
    this.runtimeWorker.startRepl();
    await this.loadHistory();
  }

  async eval(code: string): Promise<ReplResult> {
    const result = await this.runtimeWorker.evalRepl(code);
    if (result.ok && result.value !== undefined) {
      await this.appendHistory(code);
    }
    return result;
  }

  dispose(): void {
    this.runtimeWorker.disposeRepl();
  }

  getHistory(): string[] {
    return [...this.history];
  }

  private async loadHistory(): Promise<void> {
    // ponytail: no-op on missing file; history starts empty
    try {
      const content = await this.vfs.readFile(HISTORY_FILE);
      const lines = String(content).split("\n").filter(Boolean);
      this.history = lines.slice(-500);
    } catch {
      // ignore
    }
  }

  private async appendHistory(line: string): Promise<void> {
    if (!line.trim()) return;
    this.history.push(line);
    if (this.history.length > 500) {
      this.history = this.history.slice(-500);
    }
    try {
      await this.vfs.writeFile(HISTORY_FILE, this.history.join("\n") + "\n");
    } catch {
      // ignore
    }
  }
}
