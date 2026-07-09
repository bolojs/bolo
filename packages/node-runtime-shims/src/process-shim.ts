import { createEventsShim } from '@browser-containers/node-web-shims';

const { EventEmitter } = createEventsShim();

export interface ProcessShimOptions {
  readonly cwd?: string;
  readonly argv?: string[];
  readonly env?: Record<string, string | undefined>;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
}

const toText = (chunk: unknown): string =>
  typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as ArrayBufferView);

const createStdioStream = (onWrite?: (data: string) => void) => {
  const stream = new EventEmitter() as unknown as {
    write: (chunk: unknown, ...rest: unknown[]) => boolean;
    isTTY: boolean;
  };
  stream.isTTY = false;
  stream.write = (chunk: unknown, ...rest: unknown[]) => {
    onWrite?.(toText(chunk));
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  };
  return stream;
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
  let cwd = options.cwd ?? '/';
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

  const process = Object.assign(new EventEmitter(), {
    env: options.env ?? {},
    platform: 'browser' as const,
    argv: options.argv ?? ['node', '/entry.js'],
    argv0: 'node',
    execArgv: [] as string[],
    version: 'v22.0.0',
    versions: { node: '22.0.0' },
    browser: true,
    pid: 1,
    ppid: 0,
    title: 'browser-containers',
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
    cwd: () => cwd,
    chdir: (dir: string) => {
      cwd = dir;
    },
    exit: (_code?: number) => {},
    hrtime,
    stdout: createStdioStream(options.onStdout),
    stderr: createStdioStream(options.onStderr),
    stdin: createStdioStream(),
    umask: () => 0,
    uptime: () => (performance.now() - startedAt) / 1000,
    memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), {
      rss: () => 0,
    }),
  });

  return process;
};

export type ProcessShim = ReturnType<typeof createProcessShim>;
