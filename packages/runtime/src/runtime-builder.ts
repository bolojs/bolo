import type { BootOptions } from "./container-types.js";
import { BrowserContainer, type BrowserContainerDeps } from "./container.js";
import { VfsBus } from "@bolojs/fs";
import { SWSandbox } from "@bolojs/sandbox";
import { PackageManager } from "@bolojs/pm";
import { RuntimeWorker } from "./runtime-worker.js";
import { ReplService } from "./repl-service.js";
import { IframeSandbox } from "./iframe-sandbox.js";
import type { SandboxBackend } from "./sandbox-backend.js";
import { ShellService, type ShellServiceDeps } from "./shell-service.js";
import { createFileSystem } from "./fs-adapter.js";
import { createEventEmitter } from "./events.js";
import { createMount } from "./mount.js";
import { createExport } from "./export.js";
import { installNavigatorUserAgent } from "@bolojs/node-web-shims";
import { BrowserViteServer } from "@bolojs/vite-server";

declare global {
  // eslint-disable-next-line no-var
  var __vfsBus: VfsBus | undefined;
  // eslint-disable-next-line no-var
  var __sandbox: SWSandbox | undefined;
}

export class RuntimeBuilder {
  constructor(protected options: BootOptions) {}

  protected createVfs(): VfsBus {
    return this.options.vfsFactory?.() ?? new VfsBus();
  }

  protected async createSandbox(): Promise<SWSandbox> {
    const origin = globalThis.location?.origin ?? "https://sandbox.local/";
    try {
      return await SWSandbox.create({ origin, swPath: this.options.swPath ?? "/sw.js" });
    } catch {
      return { onFetch: () => {}, setPolicyRegistry: () => {} } as unknown as SWSandbox;
    }
  }

  protected createIframeSandbox(vfs: VfsBus): IframeSandbox {
    return new IframeSandbox(vfs, this.options.workdirName ?? "/home/web");
  }

  protected createRuntimeWorker(vfs: VfsBus, sandbox: SWSandbox): RuntimeWorker {
    return new RuntimeWorker(vfs, sandbox);
  }

  protected createReplService(vfs: VfsBus, worker: RuntimeWorker): ReplService {
    return new ReplService({ vfs, runtimeWorker: worker });
  }

  protected createPackageManager(vfs: VfsBus): PackageManager {
    return new PackageManager({ vfs, cwd: this.options.workdirName ?? "/home/web" });
  }

  protected createShellService(deps: ShellServiceDeps): ShellService {
    return this.options.shellService ?? new ShellService(deps);
  }

  protected createViteServer(vfs: VfsBus): BrowserViteServer | undefined {
    return new BrowserViteServer({
      vfs,
      root: this.options.workdirName ?? "/home/web",
      base: "/__preview/",
    });
  }

  protected createContainer(deps: BrowserContainerDeps): BrowserContainer {
    return new BrowserContainer(deps);
  }

  async build(): Promise<BrowserContainer> {
    // Request persistent storage to prevent browser eviction of OPFS cache
    // ponytail: not guaranteed in iframes/incognito — best effort
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {
        // Best effort — failure means cache may be evicted under storage pressure
      });
    }

    const workdir = this.options.workdirName ?? "/home/web";
    let vfs: VfsBus | null = null;

    try {
      vfs = this.createVfs();
      // IframeSandbox.init() snapshots the workdir via readdirSync before any
      // file is ever written to it — the dir must exist in the VFS up front.
      await vfs.mkdir(workdir, { recursive: true });
      // Agents commonly write one-off scripts to /tmp; create it up front so
      // `ls /` lists it and writes don't require a prior `mkdir -p`.
      await vfs.mkdir("/tmp", { recursive: true });

      const sandbox = await this.createSandbox();

      let agentSandbox: SandboxBackend | null;
      if (this.options.sandbox) {
        agentSandbox = this.options.sandbox;
      } else if (this.options.dangerouslyAllowSameOrigin) {
        agentSandbox = null;
      } else {
        const iframeSandbox = this.createIframeSandbox(vfs);
        await iframeSandbox.init();
        agentSandbox = iframeSandbox;
      }

      globalThis.__vfsBus = vfs;
      globalThis.__sandbox = sandbox;

      const runtimeWorker = this.createRuntimeWorker(vfs, sandbox);
      const replService = this.createReplService(vfs, runtimeWorker);
      const packageManager = this.createPackageManager(vfs);
      const events = createEventEmitter();
      const shellService = this.createShellService({
        vfs,
        swSandbox: sandbox,
        events,
        packageManager,
        runtimeWorker,
        sandbox: agentSandbox ?? undefined,
        workdir,
      });

      const fs = createFileSystem(vfs);
      const { mountTree } = createMount(vfs);
      const { exportTree } = createExport(vfs);

      const httpShimOptions = {
        onPortEvent: (event: string, data: { port: number; url?: string }) => {
          if (data.url) {
            if (event === "server-ready") {
              events.emit("server-ready", data.port, data.url);
            }
            const type = event === "port-close" ? "close" : "open";
            events.emit("port", data.port, type, data.url);
          }
        },
      };

      const deps: BrowserContainerDeps = {
        vfs,
        fs,
        events,
        mountApi: { mountTree },
        exportApi: { exportTree },
        processDeps: {
          shell: shellService,
          runtimeWorker,
          vfs,
          httpShimOptions,
        },
        workdir,
        replService,
      };

      const container = this.createContainer(deps);

      installNavigatorUserAgent();

      const previewBase = "/__preview/";
      const previewServer = this.createViteServer(vfs);
      if (previewServer) {
        await previewServer.start();
        let reloadTimer: ReturnType<typeof setTimeout> | null = null;
        const previewChannel = new BroadcastChannel("bolo-preview");
        vfs.watch("**", (path) => {
          if (
            path.includes("node_modules") ||
            path.endsWith("importmap.json") ||
            path.includes("/.bolo/") ||
            path.includes("/.npm-cache/")
          ) {
            return;
          }
          previewServer.broadcastHmr({ type: "full-reload", path });
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            previewChannel.postMessage({ type: "reload" });
          }, 250);
        });
        sandbox.onFetch(async (req) => {
          const url = new URL(req.url);
          if (!url.pathname.startsWith(previewBase)) {
            throw new Error("not handled");
          }
          const serverUrl = new URL(req.url);
          serverUrl.pathname = url.pathname.replace(/^\/(__preview)/, "") || "/";
          const response = await previewServer.onFetch(serverUrl.toString(), req);
          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "credentialless");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        });
        events.emit("server-ready", 3000, previewBase);
      }

      const originalTeardown = container.teardown.bind(container);
      container.teardown = async () => {
        await originalTeardown();
        agentSandbox?.dispose();
      };

      return container;
    } catch (err) {
      vfs?.destroy?.();
      throw err;
    }
  }
}
