import type { VfsBus } from '@browser-containers/vfs-bus';
import type { Process, SpawnOptions } from './container-types.js';
import type { ShellService } from './shell-service.js';
import type { RuntimeWorker } from './runtime-worker.js';

export interface ProcessDeps {
  vfs: VfsBus;
  shell: ShellService;
  runtimeWorker: RuntimeWorker;
}

export function createProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
  deps: ProcessDeps
): Process {
  let closed = false;
  let aborted = false;
  let resolveExit: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const stream = new ReadableStream<string>({
    start(controller) {
      const enqueue = (data: string) => {
        if (!closed && !aborted) {
          controller.enqueue(data);
        }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      if (command === 'runtime' && args[0] === 'run') {
        const filePath = args[1];
        if (!filePath) {
          enqueue('Usage: runtime run <script>\n');
          resolveExit(1);
          close();
          return;
        }

        deps.vfs.readFile(filePath).then((code) => {
          deps.runtimeWorker.onStdout = (data) => enqueue(data);
          deps.runtimeWorker.onStderr = (data) => enqueue(data);
          deps.runtimeWorker.onExit = (code) => {
            resolveExit(code);
            close();
          };
          deps.runtimeWorker.runScript(String(code), { filename: filePath, httpShimOptions: options.httpShimOptions });
        }).catch((err) => {
          enqueue(String(err instanceof Error ? err.message : err) + '\n');
          resolveExit(1);
          close();
        });
      } else {
        const fullCommand = [command, ...args].join(' ');
        deps.shell.execute(fullCommand, {
          stdout: enqueue,
          stderr: enqueue,
        }).then((result) => {
          if (!aborted) {
            resolveExit(result.exitCode);
          }
          close();
        }).catch((err) => {
          if (!aborted) {
            enqueue(String(err instanceof Error ? err.message : err) + '\n');
            resolveExit(1);
          }
          close();
        });
      }
    },
  });

  const kill = (): void => {
    aborted = true;
    if (!closed) {
      resolveExit(1);
    }
    deps.runtimeWorker.dispose();
  };

  return { exit, output: stream, kill };
}
