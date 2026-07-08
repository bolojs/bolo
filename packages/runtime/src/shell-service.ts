import type { VfsBus } from '@browser-containers/vfs-bus';
import type { PackageManager } from '@browser-containers/npm';
import type { SWSandbox } from '@browser-containers/sw-sandbox';
import { BrowserViteServer } from '@browser-containers/vite-server';
import { Bash } from 'just-bash/browser';
import type { RuntimeWorker } from './runtime-worker.js';
import type { SandboxPool } from './sandbox-pool.js';
import type { ContainerEvents } from './events.js';
import { VfsBashFileSystem } from './vfs-bash-fs.js';

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
  private cwd: string;
  private bash: Bash;

  constructor(deps: ShellServiceDeps) {
    this.deps = deps;
    this.cwd = deps.workdir ?? '/';
    this.bash = new Bash({ fs: new VfsBashFileSystem(deps.vfs), cwd: this.cwd });
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
    const [cmd, ...rest] = command.trim().split(/\s+/);

    if (cmd === 'npm') return this.routeNpm(rest, output);
    if (cmd === 'runtime') return this.routeRuntime(rest, output);
    if (cmd === 'agent') return this.routeAgent(rest, output);

    // just-bash restores cwd to its pre-call value after each exec(), so the
    // shell's persistent working directory is threaded through explicitly.
    const result = await this.bash.exec(command, { cwd: this.cwd });
    if (result.stdout) output.stdout(result.stdout);
    if (result.stderr) output.stderr(result.stderr);
    this.cwd = result.env.PWD ?? this.cwd;
    return result.exitCode;
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
        const server = new BrowserViteServer({ vfs: this.deps.vfs, root });
        await server.start();
        this.deps.sandbox.onFetch(async (req) => {
          const url = new URL(req.url);
          if (!url.pathname.startsWith(previewPrefix)) {
            throw new Error('not handled');
          }
          const serverUrl = new URL(req.url);
          serverUrl.pathname = url.pathname.replace(/^\/(__preview)/, '') || '/';
          const response = await server.onFetch(serverUrl.toString(), req);
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
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
