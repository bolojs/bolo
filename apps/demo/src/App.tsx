import { createSignal, onMount } from 'solid-js';
import { VfsBus } from '@browser-containers/vfs-bus';
import { SWSandbox } from '@browser-containers/sw-sandbox';
import { PackageManager } from '@browser-containers/npm';
import { RuntimeWorker, SandboxPool, ShellService, type ShellResult } from '@browser-containers/runtime';
import { boot, type BrowserContainer } from '@browser-containers/runtime';
import Terminal from './Terminal';
import Preview from './Preview';

type BootState = 'booting' | 'ready' | 'error';

declare global {
  interface Window {
    __browserbox: {
      install(pkgs?: string[]): Promise<ShellResult>;
      vfs: { writeFile(path: string, content: string): Promise<void> };
      preview: { loadUrl(url: string): void };
      boot: typeof boot;
      container?: BrowserContainer;
    };
    __browserbox_ready: boolean;
  }
}

export default function App() {
  const [bootState, setBootState] = createSignal<BootState>('booting');
  const [previewUrl, setPreviewUrl] = createSignal('');
  let shell: ShellService | undefined;
  let vfs: VfsBus | undefined;

  onMount(async () => {
    try {
      vfs = new VfsBus();

      // SWSandbox requires HTTPS + ServiceWorker. Fall back to a no-op stub so
      // the terminal tier still works on plain http://localhost during development.
      let sandbox: SWSandbox;
      try {
        sandbox = await SWSandbox.create({ origin: 'https://sandbox.local/', swPath: '/sw.js' });
      } catch (e) {
        console.warn('[demo] SWSandbox unavailable — preview disabled:', e);
        sandbox = { onFetch: () => {}, setPolicyRegistry: () => {} } as unknown as SWSandbox;
      }

      const runtimeWorker = new RuntimeWorker(vfs, sandbox);
      const sandboxPool = new SandboxPool(vfs);
      const packageManager = new PackageManager({ vfs });

      shell = new ShellService({ vfs, packageManager, runtimeWorker, sandboxPool });

      const container = await boot({ workdirName: '/home/web' });

      window.__browserbox = {
        install: (pkgs?: string[]) =>
          shell!.execute(`npm install ${pkgs?.join(' ') ?? ''}`),
        vfs: {
          writeFile: (path: string, content: string) =>
            vfs!.writeFile(path, new TextEncoder().encode(content)),
        },
        preview: { loadUrl: (url: string) => setPreviewUrl(url) },
        boot,
        container,
      };
      window.__browserbox_ready = true;

      setBootState('ready');
    } catch (e) {
      console.error('[demo] Boot failed:', e);
      setBootState('error');
    }
  });

  const execute = (
    cmd: string,
    stdout: (s: string) => void,
    stderr: (s: string) => void,
  ): Promise<ShellResult> => {
    if (!shell) return Promise.reject(new Error('Not ready'));
    return shell.execute(cmd, { stdout, stderr });
  };

  return (
    <div class="app">
      <header class="app-header">
        <span class="app-title">browser-containers</span>
        <span class={`app-status app-status--${bootState()}`}>{bootState()}</span>
      </header>
      <main class="app-panels">
        <Terminal onCommand={execute} disabled={bootState() !== 'ready'} />
        <Preview url={previewUrl()} />
      </main>
    </div>
  );
}
