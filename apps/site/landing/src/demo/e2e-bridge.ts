import { boot as runtimeBoot, type BootOptions, type BrowserContainer, type Process } from "bolojs";
import { BrowserViteServer } from "@bolojs/vite-server";

type SpawnOptions = Parameters<BrowserContainer["spawn"]>[2];

// Minimal wire bridge for E2E specs that can't reach through the DOM: VFS
// introspection and the boot-api lifecycle steps (no UI surface of their own).
// UI-driven specs drive the real ScenarioPicker/Terminal/Editor/Preview and
// never touch this — see tests/e2e/tests/browser-steps.ts.

declare global {
  interface Window {
    __browserbox?: BrowserBoxBridge;
    __browserbox_spawn_exit?: number | undefined;
    __browserbox_npm_done?: boolean;
  }
}

export interface BrowserBoxBridge {
  container?: BrowserContainer;
  boot(opts?: BootOptions): Promise<BrowserContainer>;
  setContainer(container: BrowserContainer): void;
  vfs: {
    writeFile(path: string, contents: string): Promise<void>;
    readFile(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };
  shell: {
    exec(command: string): void;
  };
  install(packages: string[]): void;
  vite: {
    transform(path: string): Promise<string>;
  };
}

/** Resolve a spec-supplied path against the container's workdir so that
 *  `/src/App.tsx` maps to `/home/web/src/App.tsx` — matching how the shell
 *  service's resolvePath and the vite server's root behave. */
function resolveWorkdir(workdir: string, path: string): string {
  if (path.startsWith(workdir)) return path;
  return path.startsWith("/") ? `${workdir}${path}` : `${workdir}/${path}`;
}

async function drainSpawnExit(proc: Process): Promise<void> {
  const reader = proc.output.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  window.__browserbox_spawn_exit = await proc.exit;
}

// Wraps `spawn` so a raw Process (a ReadableStream + a Promise, neither
// structured-cloneable) never has to cross the page.evaluate() boundary —
// Playwright steps poll `__browserbox_spawn_exit` instead of awaiting a
// return value.
function wrapContainer(container: BrowserContainer): BrowserContainer {
  return new Proxy(container, {
    get(target, prop, receiver) {
      if (prop === "spawn") {
        return (command: string, args?: string[], options?: SpawnOptions) => {
          window.__browserbox_spawn_exit = undefined;
          const proc = target.spawn(command, args, options);
          void drainSpawnExit(proc);
          return proc;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createE2eBridge(): BrowserBoxBridge {
  // `container` (exposed on window) is spawn-wrapped for direct
  // `window.__browserbox.container.spawn(...)` calls from boot-api-steps.ts.
  // `rawContainer` is used internally so shell.exec/install drain the
  // process stream exactly once instead of racing the wrapper's own drain.
  let rawContainer: BrowserContainer | undefined;
  let viteServer: BrowserViteServer | undefined;

  const bridge: BrowserBoxBridge = {
    setContainer(container: BrowserContainer) {
      rawContainer = container;
      bridge.container = wrapContainer(container);
    },

    async boot(opts?: BootOptions) {
      if (rawContainer) {
        await rawContainer.teardown();
      }
      viteServer = undefined;
      const container = await runtimeBoot(opts);
      bridge.setContainer(container);
      return container;
    },

    vfs: {
      async writeFile(path: string, contents: string) {
        if (!rawContainer) throw new Error("No container booted");
        await rawContainer.fs.writeFile(resolveWorkdir(rawContainer.workdir, path), contents);
      },
      async readFile(path: string) {
        if (!rawContainer) throw new Error("No container booted");
        return rawContainer.fs.readFile(resolveWorkdir(rawContainer.workdir, path));
      },
      async exists(path: string) {
        if (!rawContainer) throw new Error("No container booted");
        return rawContainer.fs.exists(resolveWorkdir(rawContainer.workdir, path));
      },
    },

    shell: {
      exec(command: string) {
        if (!rawContainer) throw new Error("No container booted");
        const [cmd, ...args] = command.trim().split(/\s+/);
        if (!cmd) return;
        void drainSpawnExit(rawContainer.spawn(cmd, args));
      },
    },

    install(packages: string[]) {
      if (!rawContainer) throw new Error("No container booted");
      window.__browserbox_npm_done = false;
      const proc = rawContainer.spawn("npm", ["install", ...packages]);
      void (async () => {
        await drainSpawnExit(proc);
        window.__browserbox_npm_done = true;
      })();
    },

    vite: {
      async transform(path: string): Promise<string> {
        if (!rawContainer) throw new Error("No container booted");
        if (!viteServer) {
          const vfs = (globalThis).__vfsBus;
          if (!vfs) throw new Error("No VFS available");
          viteServer = new BrowserViteServer({
            vfs,
            root: rawContainer.workdir,
            base: "",
          });
          await viteServer.start();
        }
        const resp = await viteServer.transformRequest(`http://localhost${path}`);
        return resp.text();
      },
    },
  };

  return bridge;
}
