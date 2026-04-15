import type { VfsBus } from '@browser-containers/vfs-bus';
import type { PackageManager } from '@browser-containers/npm';
import type { SWSandbox } from '@browser-containers/sw-sandbox';
import type { RuntimeWorker } from './runtime-worker.js';
import type { SandboxPool } from './sandbox-pool.js';
import type { ContainerEvents } from './events.js';

export interface ShellServiceDeps {
  vfs: VfsBus;
  sandbox?: SWSandbox;
  events?: ContainerEvents;
  packageManager: PackageManager;
  runtimeWorker: RuntimeWorker;
  sandboxPool: SandboxPool;
  workdir?: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OutputCallbacks {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
}

export class ShellService {
  private deps: ShellServiceDeps;

  constructor(deps: ShellServiceDeps) {
    this.deps = deps;
  }

  async execute(command: string, output?: Partial<OutputCallbacks>): Promise<ShellResult> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const callbacks: OutputCallbacks = {
      stdout: (data: string) => {
        stdoutChunks.push(data);
        output?.stdout?.(data);
      },
      stderr: (data: string) => {
        stderrChunks.push(data);
        output?.stderr?.(data);
      },
    };

    try {
      const exitCode = await this.route(command, callbacks);
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.stderr(message);
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: 1,
      };
    }
  }

  private async route(command: string, output: OutputCallbacks): Promise<number> {
    const tokens = command.trim().split(/\s+/);
    const [cmd, ...rest] = tokens;

    if (cmd === 'npm') return this.routeNpm(rest, output);
    if (cmd === 'runtime') return this.routeRuntime(rest, output);
    if (cmd === 'agent') return this.routeAgent(rest, output);

    output.stderr(`Unknown command: ${cmd}`);
    return 127;
  }

  private async routeNpm(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== 'install' && subcmd !== 'i') {
      if (subcmd === 'run') return this.routeNpmRun(rest, output);
      output.stderr(`Unsupported npm subcommand: ${subcmd}`);
      return 1;
    }

    try {
      if (rest.length > 0) {
        await this.deps.packageManager.install(rest);
      } else {
        await this.deps.packageManager.install();
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeNpmRun(args: string[], output: OutputCallbacks): Promise<number> {
    const scriptName = args[0];

    if (scriptName === 'dev') {
      if (!this.deps.sandbox) {
        output.stderr('No sandbox configured for dev server');
        return 1;
      }
      try {
        const root = this.deps.workdir ?? '/';
        const previewPrefix = '/__preview/';
        this.deps.sandbox.onFetch(async (req) => {
          const url = new URL(req.url);
          if (!url.pathname.startsWith(previewPrefix)) {
            throw new Error('not handled');
          }
          let pathname = url.pathname.slice(previewPrefix.length) || '/';
          if (pathname === '/') pathname = '/index.html';
          const filePath = root + pathname;
          try {
            const content = await this.deps.vfs.readFile(filePath);
            const ext = pathname.split('.').pop() ?? '';
            const mimeTypes: Record<string, string> = {
              html: 'text/html',
              js: 'application/javascript',
              mjs: 'application/javascript',
              css: 'text/css',
              json: 'application/json',
              svg: 'image/svg+xml',
              png: 'image/png',
              jpg: 'image/jpeg',
              jpeg: 'image/jpeg',
            };
            const contentType = mimeTypes[ext] ?? 'application/octet-stream';
            const body = content instanceof Uint8Array ? (content as unknown as BodyInit) : String(content);
            return new Response(body, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Opener-Policy': 'same-origin',
              },
            });
          } catch {
            return new Response('Not found', { status: 404 });
          }
        });
        this.deps.events?.emit('port', 3000, 'open', previewPrefix);
        this.deps.events?.emit('server-ready', 3000, previewPrefix);
        return 0;
      } catch (err) {
        output.stderr(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    try {
      const result = await this.deps.sandboxPool.run(scriptName);
      if (result.error) {
        output.stderr(result.error);
        return 1;
      }
      if (result.result) {
        output.stdout(result.result);
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeRuntime(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== 'run') {
      output.stderr(`Unsupported runtime subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr('Usage: runtime run <script>');
      return 1;
    }

    try {
      const code = String(await this.deps.vfs.readFile(filePath));
      this.deps.runtimeWorker.onStdout = (data) => output.stdout(data);
      this.deps.runtimeWorker.onStderr = (data) => output.stderr(data);
      await this.deps.runtimeWorker.runScript(code, { filename: filePath });
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeAgent(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== 'run') {
      output.stderr(`Unsupported agent subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr('Usage: agent run <script>');
      return 1;
    }

    try {
      const code = String(await this.deps.vfs.readFile(filePath));
      const result = await this.deps.sandboxPool.run(code);
      if (result.error) {
        output.stderr(result.error);
        return 1;
      }
      if (result.result) {
        output.stdout(result.result);
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
}
