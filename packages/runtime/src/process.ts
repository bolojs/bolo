import type { VfsBus } from "@bolojs/fs";
import type { Process, SpawnOptions } from "./container-types.js";
import type { ShellService } from "./shell-service.js";
import type { RuntimeWorker } from "./runtime-worker.js";

export interface ProcessDeps {
  vfs: VfsBus;
  shell: ShellService;
  runtimeWorker: RuntimeWorker;
  httpShimOptions?: { onPortEvent?: (event: string, data: { port: number; url?: string }) => void };
}

let processCounter = 0;

/** Exit code reported when the ceiling fires. Mirrors SIGKILL semantics. */
const TIMEOUT_EXIT_CODE = 137;

export function createProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
  deps: ProcessDeps,
): Process {
  let closed = false;
  let aborted = false;
  const tag = `proc-${++processCounter}`;
  let resolveExit: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  // Exec ceiling. Node's `spawn(..., { timeout })` kills the child when the
  // deadline passes; the browser runtime needs the same guarantee, because a
  // program that never exits (a ref'd interval, a server that never listens)
  // keeps its worker alive forever: the worker keeps posting heartbeats, so
  // the missed-heartbeat watchdog never reclaims it, and the caller waits
  // forever. The ceiling is independent of process liveness by construction —
  // it is a plain timer on the caller's side.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimeoutTimer = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };

  const streamController: ReadableStreamDefaultController<string>[] = [];
  const stream = new ReadableStream<string>({
    start(controller) {
      streamController.push(controller);
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

      // All commands — including `runtime run` — go through the shell service,
      // which routes node/bun/runtime entries through the VFS-backed bundler
      // (bundleEntry) and live shim wiring in runNodeApp.
      const fullCommand = [command, ...args].join(" ");
      deps.shell
        .execute(fullCommand, {
          stdout: enqueue,
          stderr: enqueue,
          tag,
        })
        .then((result) => {
          clearTimeoutTimer();
          if (!aborted) {
            resolveExit(result.exitCode);
          }
          close();
        })
        .catch((err) => {
          clearTimeoutTimer();
          if (!aborted) {
            enqueue(String(err instanceof Error ? err.message : err) + "\n");
            resolveExit(1);
          }
          close();
        });
    },
  });

  if (options.timeout !== undefined && options.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      // Reclaim the worker and report the ceiling, so a caller waiting on
      // `exit` is released instead of hanging forever.
      aborted = true;
      deps.shell.kill(tag);
      resolveExit(TIMEOUT_EXIT_CODE);
      if (!closed) {
        closed = true;
        // The output stream must close too: a caller draining it (the
        // compat harness reads the whole stream before awaiting `exit`)
        // would otherwise wait forever for more output.
        for (const controller of streamController) {
          try {
            controller.close();
          } catch {
            /* already closed or errored */
          }
        }
      }
    }, options.timeout);
  }

  const kill = (): void => {
    aborted = true;
    clearTimeoutTimer();
    // Terminates this process's dedicated worker when the command is a node
    // app running under the process model — a real reclaim, including
    // synchronous infinite loops. Other commands share the shell and only
    // stop reporting output.
    deps.shell.kill(tag);
    if (!closed) {
      resolveExit(1);
    }
  };

  return { exit, output: stream, kill };
}
