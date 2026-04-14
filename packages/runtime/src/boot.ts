import type { BootOptions } from './container-types.js';
import { BrowserContainer, type BrowserContainerDeps } from './container.js';
import { VfsBus } from '@browser-containers/vfs-bus';
import { SWSandbox } from '@browser-containers/sw-sandbox';
import { PackageManager } from '@browser-containers/npm';
import { RuntimeWorker } from './runtime-worker.js';
import { SandboxPool } from './sandbox-pool.js';
import { ShellService } from './shell-service.js';
import { createFileSystem } from './fs-adapter.js';
import { createEventEmitter } from './events.js';
import { createMount } from './mount.js';
import { createExport } from './export.js';

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
    throw new Error('A browser container is already running');
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
  const workdir = options?.workdirName ?? '/home/web';
  let vfs: VfsBus | null = null;

  try {
    vfs = new VfsBus();

    let sandbox: SWSandbox;
    try {
      sandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });
    } catch {
      sandbox = { onFetch: () => {}, setPolicyRegistry: () => {} } as unknown as SWSandbox;
    }

    globalThis.__vfsBus = vfs;
    globalThis.__sandbox = sandbox;

    const runtimeWorker = new RuntimeWorker(vfs, sandbox);
    const sandboxPool = new SandboxPool(vfs);
    const packageManager = new PackageManager({ vfs, cwd: workdir });
    const shellService = new ShellService({
      vfs,
      sandbox: { startDevServer: async () => {} },
      packageManager,
      runtimeWorker,
      sandboxPool,
    });

    const fs = createFileSystem(vfs);
    const events = createEventEmitter();
    const { mountTree } = createMount(vfs);
    const { exportTree } = createExport(vfs);

    const processDeps = {
      shell: shellService,
      runtimeWorker,
      vfs,
    };

    const deps: BrowserContainerDeps = {
      vfs,
      fs,
      events,
      mountApi: { mountTree },
      exportApi: { exportTree },
      processDeps,
      workdir,
    };

    const container = new BrowserContainer(deps);

    const originalTeardown = container.teardown.bind(container);
    container.teardown = async () => {
      await originalTeardown();
      activeInstance = null;
      bootPromise = null;
    };

    return container;
  } catch (err) {
    vfs?.destroy?.();
    throw err;
  }
}
