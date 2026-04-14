import type { VfsBus } from '@browser-containers/vfs-bus';
import type { RuntimeWorker } from './runtime-worker.js';
import type { ShellService } from './shell-service.js';
import type { Process, SpawnOptions } from './container-types.js';

export interface ProcessDeps {
  vfs?: VfsBus;
  runtimeWorker: RuntimeWorker;
  shellService: ShellService;
}

interface ProcessInternal {
  exit: Promise<number>;
  output: ReadableStream<string>;
  kill: () => void;
}

export const createProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
  deps: ProcessDeps,
): Process => {
  const { vfs, runtimeWorker, shellService } = deps;

  const isRuntimeRun = command === 'runtime' && args[0] === 'run' && args[1];

  if (isRuntimeRun && vfs) {
    return createRuntimeWorkerProcess(args[1], runtimeWorker, vfs);
  }

  return createShellServiceProcess(command, args, shellService);
};

const createRuntimeWorkerProcess = (
  filePath: string,
  runtimeWorker: RuntimeWorker,
  vfs: VfsBus,
): ProcessInternal => {
  let controller: ReadableStreamDefaultController<string> | null = null;
  let exitResolve: ((code: number) => void) | null = null;
  let closed = false;

  const output = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });

  const exit = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  runtimeWorker.onStdout = (data: string) => {
    if (!closed) controller?.enqueue(data);
  };

  runtimeWorker.onStderr = (data: string) => {
    if (!closed) controller?.enqueue(data);
  };

  runtimeWorker.onExit = (code: number) => {
    if (!closed) {
      closed = true;
      exitResolve?.(code);
      controller?.close();
    }
  };

  const runProcess = async () => {
    try {
      const code = await vfs.readFile(filePath);
      await runtimeWorker.runScript(String(code), { filename: filePath });
    } catch (err) {
      if (!closed) {
        closed = true;
        const message = err instanceof Error ? err.message : String(err);
        controller?.enqueue(message);
        exitResolve?.(1);
        controller?.close();
      }
    }
  };

  runProcess();

  return {
    exit,
    output,
    kill: () => {
      if (!closed) {
        closed = true;
        runtimeWorker.dispose();
        controller?.close();
        exitResolve?.(130);
      }
    },
  };
};

const createShellServiceProcess = (
  command: string,
  args: string[],
  shellService: ShellService,
): ProcessInternal => {
  let aborted = false;
  let controller: ReadableStreamDefaultController<string> | null = null;
  let exitResolve: ((code: number) => void) | null = null;
  let closed = false;

  const output = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });

  const exit = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  const fullCommand = command + (args.length > 0 ? ' ' + args.join(' ') : '');

  const runProcess = async () => {
    try {
      const result = await shellService.execute(fullCommand, {
        stdout: (data: string) => {
          if (!aborted && !closed) controller?.enqueue(data);
        },
        stderr: (data: string) => {
          if (!aborted && !closed) controller?.enqueue(data);
        },
      });

      if (!aborted && !closed) {
        closed = true;
        exitResolve?.(result.exitCode);
        controller?.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!aborted && !closed) {
        closed = true;
        controller?.enqueue(message);
        exitResolve?.(1);
        controller?.close();
      }
    }
  };

  runProcess();

  return {
    exit,
    output,
    kill: () => {
      if (!closed) {
        closed = true;
        aborted = true;
        controller?.close();
        exitResolve?.(130);
      }
    },
  };
};
