import type { VfsBus } from "@bolojs/vfs-bus";
import type { Process, SpawnOptions } from "./container-types.js";
import type { ShellService } from "./shell-service.js";
import type { RuntimeWorker } from "./runtime-worker.js";

export interface ProcessDeps {
  vfs: VfsBus;
  shell: ShellService;
  runtimeWorker: RuntimeWorker;
  httpShimOptions?: { onPortEvent?: (event: string, data: { port: number; url?: string }) => void };
}

export function createProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
  deps: ProcessDeps,
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

      // All commands — including `runtime run` — go through the shell service,
      // which routes node/bun/runtime entries through the VFS-backed bundler
      // (bundleEntry) and live shim wiring in runNodeApp.
      const fullCommand = [command, ...args].join(" ");
      deps.shell
        .execute(fullCommand, {
          stdout: enqueue,
          stderr: enqueue,
        })
        .then((result) => {
          if (!aborted) {
            resolveExit(result.exitCode);
          }
          close();
        })
        .catch((err) => {
          if (!aborted) {
            enqueue(String(err instanceof Error ? err.message : err) + "\n");
            resolveExit(1);
          }
          close();
        });
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
