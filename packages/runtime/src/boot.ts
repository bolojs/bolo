import type { BootOptions } from "./container-types.js";
import { BrowserContainer, type BrowserContainerDeps } from "./container.js";
import { VfsBus } from "@bolojs/vfs-bus";
import { SWSandbox } from "@bolojs/sw-sandbox";
import { PackageManager } from "@bolojs/npm";
import { RuntimeWorker } from "./runtime-worker.js";
import { ReplService } from "./repl-service.js";
import { IframeSandbox } from "./iframe-sandbox.js";
import type { SandboxBackend } from "./sandbox-backend.js";
import { ShellService } from "./shell-service.js";
import { createFileSystem } from "./fs-adapter.js";
import { createEventEmitter } from "./events.js";
import { createMount } from "./mount.js";
import { createExport } from "./export.js";
import { installNavigatorUserAgent } from "@bolojs/node-web-shims";
import { BrowserViteServer } from "@bolojs/vite-server";

declare global {
  var __vfsBus: VfsBus | undefined;
  var __sandbox: SWSandbox | undefined;
}

let activeInstance: BrowserContainer | null = null;
let bootPromise: Promise<BrowserContainer> | null = null;

export async function boot(options?: BootOptions): Promise<BrowserContainer> {
  if (bootPromise) {
    return bootPromise;
  }

  if (activeInstance) {
    throw new Error("A browser container is already running");
  }

  bootPromise = doBoot(options);

  try {
    const container = await bootPromise;
    activeInstance = container;
    bootPromise = null;
    return container;
  } catch (err) {
    bootPromise = null;
    throw err;
  }
}

async function doBoot(options?: BootOptions): Promise<BrowserContainer> {
  // Request persistent storage to prevent browser eviction of OPFS cache
  // ponytail: not guaranteed in iframes/incognito — best effort
  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {
      // Best effort — failure means cache may be evicted under storage pressure
    });
  }

  const workdir = options?.workdirName ?? "/home/web";
  let vfs: VfsBus | null = null;

  try {
    vfs = new VfsBus();
    // IframeSandbox.init() snapshots the workdir via readdirSync before any
    // file is ever written to it — the dir must exist in the VFS up front.
    await vfs.mkdir(workdir, { recursive: true });
    // Agents commonly write one-off scripts to /tmp; create it up front so
    // `ls /` lists it and writes don't require a prior `mkdir -p`.
    await vfs.mkdir("/tmp", { recursive: true });

    let sandbox: SWSandbox;
    try {
      const origin = globalThis.location?.origin ?? "https://sandbox.local/";
      sandbox = await SWSandbox.create({ origin, swPath: options?.swPath ?? "/sw.js" });
    } catch {
      sandbox = { onFetch: () => {}, setPolicyRegistry: () => {} } as unknown as SWSandbox;
    }

    let agentSandbox: SandboxBackend | null;
    if (options?.sandbox) {
      agentSandbox = options.sandbox;
    } else if (options?.dangerouslyAllowSameOrigin) {
      agentSandbox = null;
    } else {
      const iframeSandbox = new IframeSandbox(vfs, workdir);
      await iframeSandbox.init();
      agentSandbox = iframeSandbox;
    }

    globalThis.__vfsBus = vfs;
    globalThis.__sandbox = sandbox;

    const runtimeWorker = new RuntimeWorker(vfs, sandbox);
    const replService = new ReplService({ vfs, runtimeWorker });
    const packageManager = new PackageManager({ vfs, cwd: workdir });
    const events = createEventEmitter();
    const shellService = new ShellService({
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

    const processDeps = {
      shell: shellService,
      runtimeWorker,
      vfs,
      httpShimOptions,
    };

    const deps: BrowserContainerDeps = {
      vfs,
      fs,
      events,
      mountApi: { mountTree },
      exportApi: { exportTree },
      processDeps,
      workdir,
      replService,
    };

    const container = new BrowserContainer(deps);

    installNavigatorUserAgent();

    // ponytail: BrowserViteServer wired at boot so the preview iframe shows
    // agent work as files land in VFS, without needing `npm run dev` to fire
    // server-ready. Preview.tsx defaults iframe src to /__preview/ when SW
    // controls the page; this node + SW.onFetch for /__preview/* is the same
    // path the original `npm run dev` interception was setting up per-run.
    const previewBase = "/__preview/";
    const previewServer = new BrowserViteServer({
      vfs,
      root: workdir,
      base: previewBase,
    });
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

    const originalTeardown = container.teardown.bind(container);
    container.teardown = async () => {
      await previewServer.stop().catch(() => {});
      await originalTeardown();
      agentSandbox?.dispose();
      activeInstance = null;
      bootPromise = null;
    };
    container.teardown = async () => {
      await originalTeardown();
      agentSandbox?.dispose();
      activeInstance = null;
      bootPromise = null;
    };

    return container;
  } catch (err) {
    vfs?.destroy?.();
    throw err;
  }
}
