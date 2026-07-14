import type { VfsBus } from "@bolojs/vfs-bus";
import { transformScript } from "@bolojs/wasm-registry";
import type { SandboxBackend, SandboxRunResult } from "./sandbox-backend.js";

interface Dirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const MAX_FILE_SIZE = 1024 * 1024;

export function generateSandboxHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><script>
  let vfs = new Map();
  let port = null;

  globalThis.fs = {
    readFileSync: (path) => {
      const content = vfs.get(path);
      if (content === undefined) {
        const err = new Error(\`ENOENT: no such file or directory, open '\${path}'\`);
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    writeFileSync: (path, data) => {
      const content = typeof data === 'string' ? data : String(data);
      vfs.set(path, content);
      port?.postMessage({ type: 'vfs-write', path, content });
    },
    mkdirSync: () => {},
    rmSync: (path) => {
      vfs.delete(path);
      port?.postMessage({ type: 'vfs-delete', path });
    },
  };

  globalThis.console = {
    log: (...args) => port?.postMessage({ type: 'console', args: args.map(String) }),
    error: (...args) => port?.postMessage({ type: 'console', args: args.map(String) }),
    warn: (...args) => port?.postMessage({ type: 'console', args: args.map(String) }),
  };

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'init-port' && event.ports?.[0]) {
      port = event.ports[0];
      port.onmessage = (e) => {
        const { type, id, code, snapshot } = e.data;
        if (type === 'init') {
          for (const [path, content] of snapshot) {
            vfs.set(path, content);
          }
          port.postMessage({ type: 'ready' });
        } else if (type === 'execute') {
          try {
            const result = (0, eval)(code);
            port.postMessage({
              type: 'result',
              id,
              result: result === undefined ? 'undefined' : String(result),
            });
          } catch (err) {
            port.postMessage({
              type: 'error',
              id,
              error: err?.message ?? String(err),
            });
          }
        }
      };
    }
  });

  parent.postMessage({ type: 'sandbox-ready' }, '*');
</script></head>
<body></body>
</html>`;
}

export class IframeSandbox implements SandboxBackend {
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private pending = new Map<string, { resolve: (value: SandboxRunResult) => void }>();
  private msgId = 0;

  constructor(
    private vfs: VfsBus,
    private workdir: string,
  ) {}

  async init(): Promise<void> {
    const html = generateSandboxHtml();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);

    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-scripts");
    iframe.src = url;
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => this.handleMessage(event.data);

    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "sandbox-ready" && iframe.contentWindow) {
          window.removeEventListener("message", handler);
          iframe.contentWindow.postMessage({ type: "init-port" }, "*", [channel.port2]);
          resolve();
        }
      };
      window.addEventListener("message", handler);
    });

    const snapshot = this.buildSnapshot();
    this.port.postMessage({ type: "init", snapshot });

    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          this.port!.onmessage = (e) => this.handleMessage(e.data);
          resolve();
        }
      };
      const originalOnMessage = this.port!.onmessage;
      this.port!.onmessage = (event) => {
        handler(event);
        if (originalOnMessage) {
          originalOnMessage.call(this.port!, event);
        }
      };
    });

    this.iframe = iframe;
  }

  async run(code: string): Promise<SandboxRunResult> {
    const { code: stripped } = await transformScript(code, { loader: "ts" });
    const id = `run-${this.msgId++}`;
    return new Promise<SandboxRunResult>((resolve) => {
      this.pending.set(id, { resolve });
      this.port!.postMessage({ type: "execute", id, code: stripped });
    });
  }

  dispose(): void {
    this.port?.close();
    if (this.iframe?.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
    this.iframe = null;
    this.port = null;
  }

  private buildSnapshot(): Array<[string, string]> {
    const snapshot: Array<[string, string]> = [];
    const walk = (dir: string) => {
      const entries = this.vfs.hot.readdirSync(dir, { withFileTypes: true }) as Dirent[];
      for (const entry of entries) {
        const fullPath = `${dir}/${entry.name}`;
        if (entry.name === "node_modules") continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = this.vfs.hot.readFileSync(fullPath, "utf8");
            if (typeof content === "string" && content.length <= MAX_FILE_SIZE) {
              snapshot.push([fullPath, content]);
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    };
    walk(this.workdir);
    return snapshot;
  }

  private handleMessage(data: any): void {
    if (data.type === "result" || data.type === "error") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === "result") {
        pending.resolve({ result: data.result });
      } else {
        pending.resolve({ error: data.error });
      }
      this.pending.delete(data.id);
      return;
    }

    if (data.type === "vfs-write") {
      this.vfs.hot.writeFileSync(data.path, data.content);
      return;
    }

    if (data.type === "vfs-delete") {
      this.vfs.hot.rmSync(data.path, { recursive: true, force: true });
      return;
    }

    if (data.type === "console") {
      console.log("[sandbox]", ...data.args);
      return;
    }
  }
}
