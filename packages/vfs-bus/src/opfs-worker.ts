import { opfsWorkerScript } from "./opfs-worker-script.js";

interface OpfsRequest {
  id: number;
  method: "readFile" | "writeFile" | "mkdir" | "readdir" | "rm" | "exists";
  path: string;
  content?: Uint8Array;
}

interface OpfsOk {
  id: number;
  ok: true;
  data?: Uint8Array | string[] | boolean;
}

interface OpfsErr {
  id: number;
  ok: false;
  error: string;
}

type OpfsResponse = OpfsOk | OpfsErr;

function createWorkerBlob(): Worker {
  const blob = new Blob([opfsWorkerScript], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}

export const OPFS_UNAVAILABLE = Symbol("OPFS_UNAVAILABLE");

export class OpfsWorker {
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (v: OpfsResponse) => void }>();
  private nextId = 0;

  async init(): Promise<void> {
    if (this.worker) {
      this.setupMessageHandler();
      return;
    }
    try {
      this.worker = createWorkerBlob();
      this.setupMessageHandler();
    } catch {
      this.worker = null;
    }
  }

  private setupMessageHandler(): void {
    if (!this.worker) return;
    this.worker.onmessage = (e: MessageEvent<OpfsResponse>) => {
      const pending = this.pending.get(e.data.id);
      if (pending) {
        pending.resolve(e.data);
        this.pending.delete(e.data.id);
      }
    };
  }

  private async send<T>(
    method: OpfsRequest["method"],
    path: string,
    content?: Uint8Array,
  ): Promise<T> {
    await this.init();
    if (!this.worker) throw new Error("OPFS Worker unavailable");

    const id = this.nextId++;
    const msg: OpfsRequest = { id, method, path, content };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OPFS Worker timeout: ${method} ${path}`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          if (resp.ok) resolve(resp.data as T);
          else reject(new Error(resp.error));
        },
      });

      this.worker!.postMessage(msg);
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.send<Uint8Array>("readFile", path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    return this.send<void>("writeFile", path, content);
  }

  async mkdir(path: string): Promise<void> {
    return this.send<void>("mkdir", path);
  }

  async readdir(path: string): Promise<string[]> {
    return this.send<string[]>("readdir", path);
  }

  async rm(path: string): Promise<void> {
    return this.send<void>("rm", path);
  }

  async exists(path: string): Promise<boolean> {
    return this.send<boolean>("exists", path);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      p.resolve({ id: -1, ok: false, error: "Worker terminated" });
    }
    this.pending.clear();
  }
}
