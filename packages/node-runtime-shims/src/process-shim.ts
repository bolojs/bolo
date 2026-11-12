import { createEventsShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();

export interface ProcessShimOptions {
  readonly cwd?: string;
  readonly argv?: string[];
  readonly env?: Record<string, string | undefined>;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
  /**
   * Resolves a `node:*` builtin name (with or without the `node:` prefix)
   * to its live shim — the backing for `process.getBuiltinModule`.
   */
  readonly getBuiltinModule?: (name: string) => unknown;
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

/**
 * Node coerces every env write through ToString — `process.env.N = 42` reads
 * back "42" (test-process-env). A Proxy over a plain backing map also keeps
 * `delete process.env.X`, `'X' in process.env` and Object.keys/spread
 * enumeration working with no extra traps.
 */
const createEnv = (initial: Record<string, string | undefined> = {}) => {
  const backing: Record<string, string> = {};
  for (const [key, value] of Object.entries(initial)) {
    if (value !== undefined) backing[key] = String(value);
  }
  return new Proxy(backing, {
    set: (target, key, value) => {
      target[key as string] = String(value);
      return true;
    },
  });
};

// There is no real host CPU to report; browsers mask architecture anyway.
// UA sniffing catches the arm64 case (Apple Silicon reports "arm" in some
// engines); everything else defaults to x64 like the wasm-era baseline.
const detectArch = (): string => {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const hint = `${nav?.userAgent ?? ""} ${nav?.platform ?? ""}`;
  return /arm|aarch64/i.test(hint) ? "arm64" : "x64";
};

const stripNodePrefix = (name: string): string =>
  name.startsWith("node:") ? name.slice("node:".length) : name;

interface EmitWarningOptions {
  type?: string;
  code?: string;
  ctor?: new (message: string) => Error;
  detail?: string;
}

// Mirrors Node's ERR_INVALID_ARG_TYPE phrasing ("Received type string ('x')").
const describeReceived = (value: unknown): string => {
  if (value == null) return ` Received ${value}`;
  if (typeof value === "function") return ` Received function ${value.name}`;
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    return name ? ` Received an instance of ${name}` : " Received [Object: null prototype]";
  }
  let shown = String(typeof value === "symbol" ? value.toString() : value);
  if (typeof value === "string") shown = `'${value}'`;
  if (typeof value === "bigint") shown = `${value}n`;
  return ` Received type ${typeof value} (${shown})`;
};

// Named `process` on purpose: V8's "Cannot delete property" message uses the
// constructor name, and Node prints `#<process>`.
const ProcessShim = class process extends EventEmitter {};

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
      if (prev !== undefined) {
        // Node's validateTuple: the argument must be a 2-element Array of
        // numbers — anything else is a synchronous ERR_INVALID_ARG_TYPE.
        if (!Array.isArray(prev)) {
          throw Object.assign(
            new TypeError(
              `The "time" argument must be an instance of Array.${describeReceived(prev)}`,
            ),
            { code: "ERR_INVALID_ARG_TYPE" },
          );
        }
        if (prev.length !== 2) {
          throw Object.assign(
            new RangeError(
              `The "time" argument must contain exactly 2 elements. Received ${prev.length} elements`,
            ),
            { code: "ERR_OUT_OF_RANGE" },
          );
        }
        for (const i of [0, 1] as const) {
          if (typeof prev[i] !== "number" || !Number.isFinite(prev[i])) {
            throw Object.assign(
              new TypeError(
                `The "time[${i}]" argument must be of type number.${describeReceived(prev[i])}`,
              ),
              { code: "ERR_INVALID_ARG_TYPE" },
            );
          }
        }
      }
      const elapsedMs = performance.now() - startedAt;
      const sec = Math.floor(elapsedMs / 1000);
      const nsec = Math.floor((elapsedMs % 1000) * 1e6);
      if (!prev) return [sec, nsec];
      // Node borrows so the nanoseconds component stays non-negative.
      let ds = sec - prev[0];
      let dns = nsec - prev[1];
      if (dns < 0) {
        ds -= 1;
        dns += 1e9;
      }
      return [ds, dns];
    },
    { bigint: () => BigInt(Math.round((performance.now() - startedAt) * 1e6)) },
  );

  let exiting = false;
  // Node's setUncaughtExceptionCaptureCallback: when set, it *replaces* the
  // 'uncaughtException' emit (listeners are not called and the default crash
  // is skipped). Wired into the emit() override below.
  let uncaughtExceptionCapture: ((err: unknown) => void) | null = null;

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

  // `process.exitCode` accepts only integer-ish values (or a numeric string);
  // anything else throws ERR_INVALID_ARG_TYPE like Node.
  let exitCode: number | undefined;
  const validateExitCode = (code: unknown): number | undefined => {
    if (code === undefined || code === null) return undefined;
    if (typeof code === "number") {
      if (!Number.isInteger(code)) {
        throw Object.assign(
          new TypeError(`The "code" argument must be an integer. Received ${String(code)}`),
          { code: "ERR_INVALID_ARG_TYPE" },
        );
      }
      return code;
    }
    if (typeof code === "string") {
      const trimmed = code.trim();
      if (!/^[+-]?\d+$/.test(trimmed)) {
        throw Object.assign(
          new TypeError(`The "code" argument must be an integer. Received type string ('${code}')`),
          { code: "ERR_INVALID_ARG_TYPE" },
        );
      }
      return Number(trimmed);
    }
    throw Object.assign(
      new TypeError(`The "code" argument must be an integer. Received${describeReceived(code)}`),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  };

  const process = Object.assign(new EventEmitter(), {
    // Node's error text says `Cannot delete property 'exitCode' of #<process>`;
    // the object stringifies via its constructor, so name the class.
    constructor: ProcessShim,
    /** Validating accessor — defined below (Object.assign drops accessors). */
    exitCode: undefined as number | undefined,
    env: createEnv(options.env),
    platform: "browser" as const,
    arch: detectArch(),
    argv: options.argv ?? ["node", "/entry.js"],
    argv0: "node",
    execArgv: [] as string[],
    // Best-effort executable path — there is no real node binary on disk,
    // but tools read execPath for re-spawn/shebang logic.
    execPath: "/usr/local/bin/node",
    // Track an actively-maintained LTS line: tools gate on `process.version`
    // (e.g. rspack requires >=20.19 or >=22.12), and 22.0.0 fails those checks
    // even when the shimmed APIs they actually call are present.
    version: "v22.12.0",
    versions: { node: "22.12.0" },
    release: { name: "node", version: "22.12.0" },
    features: {
      inspector: false,
      debug: false,
      uv: false,
      ipv6: false,
      tls: false,
      tls_alpn: false,
      tls_sni: false,
      tls_ocsp: false,
      cached_builtins: true,
    },
    config: {
      target_defaults: {} as Record<string, unknown>,
      variables: {} as Record<string, unknown>,
    },
    browser: true,
    pid: 1,
    ppid: 0,
    title: "bolo",
    /** Runs queued nextTick callbacks now; the host calls it after each macrotask callback. */
    drainTicks: () => drainTicks(),
    /** True once 'exit' has begun; Node ignores nextTick callbacks scheduled after that. */
    _exiting: false,
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (typeof fn !== "function") {
        const err = new TypeError(
          `The "callback" argument must be of type function. Received ${
            fn === null || fn === undefined ? String(fn) : `type ${typeof fn}`
          }`,
        ) as TypeError & { code: string };
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (process._exiting) return;
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
    exit: (code?: number | string): never => {
      if (code !== undefined) {
        // Validate before emitting anything — Node throws synchronously.
        const normalized = validateExitCode(code);
        process.exitCode = normalized;
      }
      // Node: process.exit() inside an 'exit' handler just re-asserts the
      // pending exit — the handlers already ran, recursion is a no-op.
      if (process._exiting) throw new ProcessExit(process.exitCode ?? 0);
      try {
        process.emit("exit", process.exitCode ?? 0);
      } catch (err) {
        if (!(err instanceof ProcessExit)) throw err;
      }
      throw new ProcessExit(process.exitCode ?? 0);
    },
    // process.reallyExit: exit NOW — no 'exit' handlers, no stdio flush wait.
    // The worker catches ProcessExit and finishes without emitting 'exit'.
    reallyExit: (code?: number | string): never => {
      if (code !== undefined) process.exitCode = validateExitCode(code);
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
    emitWarning: (
      warning: string | Error,
      optsOrType?: EmitWarningOptions | string,
      code?: string,
      ctor?: new (message: string) => Error,
    ) => {
      let type = "Warning";
      let warnCode: string | undefined;
      let WarnCtor = ctor;
      let detail: string | undefined;
      if (typeof optsOrType === "string") {
        type = optsOrType;
        warnCode = code;
      } else if (optsOrType && typeof optsOrType === "object") {
        type = optsOrType.type ?? type;
        warnCode = optsOrType.code;
        WarnCtor = optsOrType.ctor;
        detail = optsOrType.detail;
      }
      const err =
        warning instanceof Error
          ? warning
          : WarnCtor
            ? new WarnCtor(String(warning))
            : new Error(String(warning));
      if (type !== "Warning" || !(warning instanceof Error)) err.name = type;
      if (warnCode !== undefined) (err as Error & { code?: string }).code = warnCode;
      if (detail !== undefined) (err as Error & { detail?: string }).detail = detail;
      process.emit("warning", err);
      // Node prints warnings to stderr by default (no --no-warnings flag here).
      const detailSuffix = detail ? `\n${detail}` : "";
      process.stderr.write(`(node:${process.pid}) ${type}: ${err.message}${detailSuffix}\n`);
    },
    setUncaughtExceptionCaptureCallback: (cb: ((err: unknown) => void) | null) => {
      if (cb !== null && typeof cb !== "function") {
        const err = new TypeError(
          `The "fn" argument must be of type function or null.${describeReceived(cb)}`,
        ) as TypeError & { code: string };
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      uncaughtExceptionCapture = cb;
    },
    hasUncaughtExceptionCaptureCallback: () => uncaughtExceptionCapture !== null,
    getBuiltinModule: (name: string): unknown => options.getBuiltinModule?.(stripNodePrefix(name)),
  });

  // `Object.assign` copies accessor *values*, not the accessor itself — define
  // `exitCode` as a real validating accessor afterwards.
  Object.defineProperty(process, "exitCode", {
    enumerable: true,
    // Node: `delete process.exitCode` throws "Cannot delete property …".
    configurable: false,
    get: () => exitCode,
    set: (code: number | string | undefined | null) => {
      exitCode = validateExitCode(code);
    },
  });

  // 'exit' fires at most once, whether triggered by process.exit() or by the
  // embedder at natural completion.
  const emit = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  process.emit = ((event: string, ...args: unknown[]) => {
    if (event === "exit") {
      if (exiting) return false;
      exiting = true;
      process._exiting = true;
    }
    // The capture callback replaces the 'uncaughtException' emit entirely —
    // listeners are not invoked and the host's default crash path is skipped.
    if (event === "uncaughtException" && uncaughtExceptionCapture) {
      uncaughtExceptionCapture(args[0]);
      return true;
    }
    return emit(event, ...args);
  }) as typeof process.emit;

  return process;
};

export type ProcessShim = ReturnType<typeof createProcessShim>;
