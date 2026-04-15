import { createSignal, onMount, onCleanup } from 'solid-js';
import { boot, type BrowserContainer, type ShellResult } from '@browser-containers/runtime';
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

function parseCommand(cmd: string): { command: string; args: string[] } {
  const tokens = cmd.trim().split(/\s+/);
  return { command: tokens[0] ?? '', args: tokens.slice(1) };
}

async function readStream(
  stream: ReadableStream<string>,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout(value);
    }
    return 0;
  } finally {
    reader.releaseLock();
  }
}

export default function App() {
  const [bootState, setBootState] = createSignal<BootState>('booting');
  const [previewUrl, setPreviewUrl] = createSignal('');
  let container: BrowserContainer | undefined;

  onMount(async () => {
    try {
      container = await boot({ workdirName: '/home/web' });

      const unsubPort = container.on('port', (_port, type, url) => {
        if (type === 'open') {
          setPreviewUrl(url);
        }
      });

      window.__browserbox = {
        install: async (pkgs?: string[]) => {
          const { command, args } = parseCommand(`npm install ${pkgs?.join(' ') ?? ''}`);
          const proc = container!.spawn(command, args);
          const exitCode = await proc.exit;
          return { exitCode, stdout: '', stderr: '' };
        },
        vfs: {
          writeFile: (path: string, content: string) =>
            container!.fs.writeFile(path, content),
        },
        preview: { loadUrl: (url: string) => setPreviewUrl(url) },
        boot,
        container,
      };
      window.__browserbox_ready = true;

      // Mount starter app (plain HTML to avoid COEP cross-origin module issues in alpha)
      await container.mount({
        'package.json': {
          file: {
            contents: JSON.stringify(
              {
                name: 'starter-app',
                type: 'module',
                scripts: {
                  dev: 'echo "dev server ready"',
                },
                dependencies: {
                  react: '^18.2.0',
                  'react-dom': '^18.2.0',
                },
                devDependencies: {
                  vite: '^5.0.0',
                },
              },
              null,
              2,
            ),
          },
        },
        'index.html': {
          file: {
            contents: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Starter App</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; background: #0d1117; color: #e6edf3; }
      h1 { color: #58a6ff; }
    </style>
  </head>
  <body>
    <h1>Hello from browser-containers!</h1>
    <p>This app is running entirely inside your browser.</p>
    <p id="time"></p>
    <script>
      document.getElementById('time').textContent = 'Loaded at ' + new Date().toLocaleTimeString();
    </script>
  </body>
</html>`,
          },
        },
      });

      // Auto-install and auto-start dev server
      const installProc = container.spawn('npm', ['install', '--ignore-scripts']);
      await installProc.exit;

      const devProc = container.spawn('npm', ['run', 'dev']);
      // Fire-and-forget; output stream is consumed by the runtime
      void devProc.exit;

      setBootState('ready');

      onCleanup(() => {
        unsubPort();
      });
    } catch (e) {
      console.error('[demo] Boot failed:', e);
      setBootState('error');
    }
  });

  const execute = async (
    cmd: string,
    stdout: (s: string) => void,
    stderr: (s: string) => void,
  ): Promise<ShellResult> => {
    if (!container) return Promise.reject(new Error('Not ready'));
    const { command, args } = parseCommand(cmd);
    const proc = container.spawn(command, args);
    const exitCode = await readStream(proc.output, stdout, stderr);
    return { exitCode, stdout: '', stderr: '' };
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
