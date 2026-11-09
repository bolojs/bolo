import { createEventsShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();

export interface ProcessShimOptions {
  readonly cwd?: string;
  readonly argv?: string[];
  readonly env?: Record<string, string | undefined>;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
}

/**
 * Thrown by `process.exit()` to unwind the caller's stack, since the main
 * thread cannot be terminated. Embedders (ShellService.runNodeApp) catch it and
 * report `code` as the exit status. Scripts that swallow it with a bare
 * try/catch will keep running: a limit of the main-thread stopgap, resolved by
 * the worker-per-process model (v0.2.0).
 */
export class ProcessExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExit";
    this.code = code;
  }
}

const toText = (chunk: unknown): string =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as ArrayBufferView);

const createStdioStream = (onWrite?: (data: string) => void) => {
  const stream = new EventEmitter() as unknown as {
    write: (chunk: unknown, ...rest: unknown[]) => boolean;
    isTTY: boolean;
  };
  stream.isTTY = false;
  stream.write = (chunk: unknown, ...rest: unknown[]) => {
    onWrite?.(toText(chunk));
    const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  };
  return stream;
};

type MemUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

const memoryUsage = (): MemUsage => {
  const chromeMem = (performance as any).memory;
  if (chromeMem) {
    return {
      heapTotal: chromeMem.totalHeapSize,
      heapUsed: chromeMem.usedHeapSize,
      // ponytail: no reliable source for these fields; keep them zero as best-effort values
      external: 0,
      // ponytail: ditto — no browser API exposes ArrayBuffer allocation accounting
      arrayBuffers: 0,
      rss: chromeMem.totalHeapSize,
    };
  }
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
};

/**
 * A "real-ish" `process` shared by every bundled node app in this container.
 * Unlike a static polyfill, `stdout`/`stderr` writes are wired to the
 * caller-supplied callbacks (the shell's own stdout/stderr) so `console.log`
 * (which routes through `process.stdout.write` in most node builds) and
 * direct `process.stdout.write` calls both surface in the terminal instead of
 * being silently discarded.
 */
export const createProcessShim = (options: ProcessShimOptions = {}) => {
  let cwd = options.cwd ?? "/";
  const startedAt = performance.now();

  const hrtime = Object.assign(
    (prev?: [number, number]): [number, number] => {
      const elapsedMs = performance.now() - startedAt;
      const sec = Math.floor(elapsedMs / 1000);
      const nsec = Math.floor((elapsedMs % 1000) * 1e6);
      if (!prev) return [sec, nsec];
      return [sec - prev[0], nsec - prev[1]];
    },
    { bigint: () => BigInt(Math.round((performance.now() - startedAt) * 1e6)) },
  );

  let exiting = false;

  // nextTick queue: drained after the microtasks already queued when the first
  // tick is scheduled, and nested ticks join the same drain (Node runs the
  // whole tick queue before returning to promise jobs).
  const tickQueue: Array<() => void> = [];
  let tickScheduled = false;
  const drainTicks = () => {
    try {
      while (tickQueue.length > 0) tickQueue.shift()!();
    } finally {
      tickScheduled = false;
      if (tickQueue.length > 0) {
        tickScheduled = true;
        queueMicrotask(drainTicks);
      }
    }
  };

  const process = Object.assign(new EventEmitter(), {
    exitCode: undefined as number | undefined,
    env: options.env ?? {},
    platform: "browser" as const,
    argv: options.argv ?? ["node", "/entry.js"],
    argv0: "node",
    execArgv: [] as string[],
    version: "v22.0.0",
    versions: { node: "22.0.0" },
    browser: true,
    pid: 1,
    ppid: 0,
    title: "bolo",
    /** Runs queued nextTick callbacks now; the host calls it after each macrotask callback. */
    drainTicks: () => drainTicks(),
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      tickQueue.push(() => fn(...args));
      if (!tickScheduled) {
        tickScheduled = true;
        queueMicrotask(drainTicks);
      }
    },
    cwd: () => cwd,
    chdir: (dir: string) => {
      cwd = dir;
    },
    exit: (code?: number): never => {
      if (code !== undefined) process.exitCode = code;
      try {
        process.emit("exit", process.exitCode ?? 0);
      } catch (err) {
        if (!(err instanceof ProcessExit)) throw err;
      }
      throw new ProcessExit(process.exitCode ?? 0);
    },
    hrtime,
    stdout: createStdioStream(options.onStdout),
    stderr: createStdioStream(options.onStderr),
    stdin: createStdioStream(),
    umask: () => 0,
    uptime: () => (performance.now() - startedAt) / 1000,
    memoryUsage: Object.assign(memoryUsage, {
      rss: () => (performance as any).memory?.totalHeapSize ?? 0,
    }),
  });

  // 'exit' fires at most once, whether triggered by process.exit() or by the
  // embedder at natural completion.
  const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  process.emit = ((event: string, ...args: unknown[]) => {
    if (event === "exit") {
      if (exiting) return false;
      exiting = true;
    }
    return emit(event, ...args);
  }) as typeof process.emit;

  return process;
};

export type ProcessShim = ReturnType<typeof createProcessShim>;
