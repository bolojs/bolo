import { ProcessExit } from "@bolojs/node-runtime-shims";

/** Minimal slice of the process shim that the supervisor needs. */
export interface SupervisedProcess {
  exitCode?: number | undefined;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

export interface SuperviseOptions {
  process: SupervisedProcess;
  /** Executes the user program (bundle import). Resolves when top-level code finishes. */
  run: () => Promise<unknown>;
  /** Raw stderr sink (ungated). */
  stderr: (data: string) => void;
  /** Returns true once the program opened a listening server; skips the quiescence wait. */
  isServing?: () => boolean;
  /** Upper bound for the quiescence wait. Default 5000ms. */
  quiescenceCapMs?: number;
  /** Where uncaught `error` / `unhandledrejection` events arrive. Default `globalThis`. */
  target?: EventTarget;
  nodeVersion?: string;
}

export interface SuperviseResult {
  exitCode: number;
  /** True when the program exited explicitly or crashed; later output must be dropped. */
  terminated: boolean;
}

const formatUncaught = (err: unknown, version: string): string => {
  const body = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `Uncaught ${body}\n\nNode.js ${version}\n`;
};

/**
 * Main-thread stopgap that gives a bundled node app Node-like termination
 * semantics: `process.exit()` (via the `ProcessExit` sentinel), `exitCode`,
 * uncaught exceptions and unhandled rejections (exit 1), and a bounded wait
 * for pending timers before reporting the exit status.
 *
 * Known limit: this runs in the host realm. A synchronous infinite loop
 * cannot be reclaimed, a script can swallow the sentinel with a bare
 * try/catch, and globals leak between runs. The worker-per-process model
 * (v0.2.0) replaces this.
 */
export const superviseRun = async (options: SuperviseOptions): Promise<SuperviseResult> => {
  const { process: proc, run, stderr } = options;
  const target = options.target ?? globalThis;
  const version = options.nodeVersion ?? "v22.0.0";
  const cap = options.quiescenceCapMs ?? 5000;

  let terminal: { code: number } | undefined;
  let explicitExit = false;
  const terminate = (code: number) => {
    if (!terminal) terminal = { code };
  };

  const onFatal = (err: unknown) => {
    if (terminal) return;
    if (err instanceof ProcessExit) {
      explicitExit = true;
      terminate(err.code);
      return;
    }
    if (proc.listenerCount("uncaughtException") > 0) {
      proc.emit("uncaughtException", err, "uncaughtException");
      return;
    }
    stderr(formatUncaught(err, version));
    terminate(1);
  };

  const onError = (event: Event) => {
    onFatal((event as ErrorEvent).error ?? (event as ErrorEvent).message);
    event.preventDefault?.();
  };
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (reason instanceof ProcessExit) {
      onFatal(reason);
    } else if (proc.listenerCount("unhandledRejection") === 0) {
      onFatal(reason);
    }
    event.preventDefault?.();
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  // Track pending timers so we know when the "event loop" is empty.
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
  const origSet = g.setTimeout!;
  const origClear = g.clearTimeout!;
  const origSetInterval = g.setInterval!;
  const origClearInterval = g.clearInterval!;
  const pending = new Set<unknown>();
  g.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id: unknown = origSet(
      (...a: unknown[]) => {
        pending.delete(id);
        fn(...a);
      },
      ms,
      ...rest,
    );
    pending.add(id);
    return id;
  }) as never;
  g.clearTimeout = ((id: unknown) => {
    pending.delete(id);
    return origClear(id);
  }) as never;
  g.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = origSetInterval(fn, ms, ...rest);
    pending.add(id);
    return id;
  }) as never;
  g.clearInterval = ((id: unknown) => {
    pending.delete(id);
    return origClearInterval(id);
  }) as never;

  const sleep = (ms: number) => new Promise<void>((resolve) => origSet(resolve, ms));

  try {
    try {
      await run();
    } catch (err) {
      onFatal(err);
    }

    const deadline = Date.now() + cap;
    // Always give microtasks and zero-delay callbacks one turn to surface errors.
    await sleep(0);
    while (!terminal && !options.isServing?.() && pending.size > 0 && Date.now() < deadline) {
      await sleep(5);
    }
    await sleep(0);

    if (terminal) {
      // Node fires 'exit' after an uncaught exception too (handlers such as
      // common.expectExitCode rely on it); process.exit() already fired it.
      if (!explicitExit) {
        try {
          proc.emit("exit", terminal.code);
        } catch (err) {
          if (err instanceof ProcessExit) terminal = { code: err.code };
        }
      }
      return { exitCode: terminal.code, terminated: true };
    }

    try {
      proc.emit("beforeExit", proc.exitCode ?? 0);
      proc.emit("exit", proc.exitCode ?? 0);
    } catch (err) {
      onFatal(err);
      if (terminal) return { exitCode: (terminal as { code: number }).code, terminated: true };
    }
    return { exitCode: proc.exitCode ?? 0, terminated: false };
  } finally {
    g.setTimeout = origSet as never;
    g.clearTimeout = origClear as never;
    g.setInterval = origSetInterval as never;
    g.clearInterval = origClearInterval as never;
    if (!options.isServing?.()) for (const id of pending) origClear(id);
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  }
};
