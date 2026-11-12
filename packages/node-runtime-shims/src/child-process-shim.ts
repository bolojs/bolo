import { createEventsShim, createStreamShim, createBufferShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();
const { Readable, Writable } = createStreamShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (a pre-existing
// tsc declaration-emit quirk on unenv's untyped default export), so read it off the
// runtime value instead of trusting the type.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

// ponytail: module-level counter, good enough; real OS pids never collide either
let nextPid = 1000;

export interface WasmRegistry {
  dispatch(
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ShellService {
  exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface WorkerOptions {
  createWorker?: (
    scriptPath: string,
    args: string[],
    env?: Record<string, string>,
    cwd?: string,
  ) => WorkerLike | undefined;
}

const bufferFrom = (value: unknown): Buffer => {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.from(String(value));
};

const dispatchCommand = async (
  command: string,
  args: string[],
  registry?: WasmRegistry,
  shell?: ShellService,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  if (registry) {
    const result = await registry.dispatch(command, args);
    if (result.exitCode !== 0 && result.stderr.includes("WASM tool not found") && shell) {
      return shell.exec(command, args);
    }
    return result;
  }
  if (shell) return shell.exec(command, args);
  return { stdout: "", stderr: "No registry or shell available", exitCode: 1 };
};

/**
 * unenv's own `Readable` doesn't implement flowing-mode delivery (`push` is a
 * no-op), so — same as `IncomingMessageImpl` in http-shim.ts — this emits
 * 'data'/'end' directly. `dispatch`/`shell.exec` only ever resolve a fully
 * buffered stdout/stderr string (no real incremental streaming from the
 * underlying bash/wasm dispatch), so each stream gets at most one 'data'
 * event before 'end'.
 */
class StdioReadable extends Readable {
  emitOutput(text: string): void {
    this.pushChunk(text);
    this.emit("end");
  }

  pushChunk(chunk: string | Uint8Array): void {
    if (typeof chunk === "string" && chunk.length === 0) return;
    this.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  end(): void {
    this.emit("end");
  }

  override read(): unknown {
    return null;
  }
}

/**
 * Nothing consumes stdin on the dispatch/shell.exec path (neither interface
 * accepts input), so writes are accepted (to match real `ChildProcess.stdin`
 * being a valid `Writable`) but discarded.
 */
class StdinWritable extends Writable {
  override _write(
    _chunk: unknown,
    _encoding: string,
    callback?: (error?: Error | null) => void,
  ): void {
    callback?.();
  }
}

class WorkerStdinWritable extends Writable {
  constructor(private readonly worker: WorkerLike) {
    // decodeStrings: false — forward the caller's chunk verbatim over the
    // worker channel (the "stdin" message protocol predates Buffer-decoding
    // Writable defaults and its consumers expect the original value).
    super({ decodeStrings: false });
  }

  override _write(
    chunk: unknown,
    _encoding: string,
    callback?: (error?: Error | null) => void,
  ): void {
    this.worker.postMessage({ type: "stdin", data: chunk });
    callback?.();
  }
}

class ChildProcessImpl extends EventEmitter implements ChildProcess {
  readonly stdin: InstanceType<typeof Writable>;
  readonly stdout: StdioReadable = new StdioReadable();
  readonly stderr: StdioReadable = new StdioReadable();
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  /** argv as passed to the OS-level spawn — the dispatched command itself. */
  spawnfile = "";
  spawnargs: readonly string[] = [];
  /** Node exposes stdio as [stdin, stdout, stderr, ...extra fds]. */
  get stdio() {
    return [this.stdin, this.stdout, this.stderr] as const;
  }
  // ref()/unref() are real hold-process-open handles in Node; here liveness is
  // owned by the process worker's handle table, so they're no-ops returning
  // `this` like Node's ChildProcess does.
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }

  constructor(stdin?: InstanceType<typeof Writable>) {
    super();
    this.stdin = stdin ?? new StdinWritable();
  }

  kill(signal?: string | number): boolean {
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    return true;
  }
}

class WorkerChildProcessImpl extends ChildProcessImpl {
  readonly pid = nextPid++;
  private readonly worker: WorkerLike;

  constructor(worker: WorkerLike) {
    super(new WorkerStdinWritable(worker));
    this.worker = worker;
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      this.emit(
        "error",
        event.error instanceof Error
          ? event.error
          : new Error(String(event.error ?? "Worker error")),
      );
      this.cleanup();
    };
  }

  private handleMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const message = data as Record<string, unknown>;

    if (message.stream === "stdout") {
      this.stdout.pushChunk(bufferFrom(message.data));
    } else if (message.stream === "stderr") {
      this.stderr.pushChunk(bufferFrom(message.data));
    } else if (message.type === "exit") {
      const code = typeof message.code === "number" ? message.code : 0;
      this.exitCode = code;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", code, null);
      this.emit("close", code, null);
      this.cleanup();
    } else if (message.type === "IPC_MESSAGE") {
      this.emit("message", message.data);
    } else if (message.type === "IPC_DISCONNECT") {
      this.emit("disconnect");
    }
  }

  private cleanup(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
  }

  send(message: unknown): boolean {
    this.worker.postMessage({ type: "IPC_MESSAGE", data: message });
    return true;
  }

  disconnect(): void {
    this.worker.postMessage({ type: "IPC_DISCONNECT" });
  }

  override kill(signal?: string | number): boolean {
    this.killed = true;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    this.worker.terminate();
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    this.cleanup();
    return true;
  }
}

const runChild = (
  command: string,
  args: string[],
  registry?: WasmRegistry,
  shell?: ShellService,
): ChildProcessImpl => {
  const child = new ChildProcessImpl();
  child.spawnfile = command;
  child.spawnargs = [command, ...args];

  (async () => {
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await dispatchCommand(command, args, registry, shell);
    } catch (error) {
      child.emit("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.stdout.emitOutput(result.stdout);
    child.stderr.emitOutput(result.stderr);
    child.exitCode = result.exitCode;
    child.emit("exit", result.exitCode, null);
    child.emit("close", result.exitCode, null);
  })();

  return child;
};

const SYNC_NOT_SUPPORTED =
  "Synchronous child_process calls are not supported: command dispatch in this environment is always " +
  "asynchronous (bash interpreter / wasm tool / bundler), and the browser main thread cannot block on a " +
  "Promise. Use the async spawn()/exec() APIs instead.";

const FORK_NOT_SUPPORTED =
  "POSIX fork(2) is not supported in this environment: V8 has no heap-snapshot/clone API, no MMU page-table access, " +
  "and no resumable continuations across isolates (see ADR-0007). " +
  "Node's child_process.fork(modulePath) IS supported via Worker + IPC; " +
  "pass a createWorker factory to createChildProcessShim to enable it.";

const isNodeCommand = (command: string): boolean =>
  command === "node" || command.endsWith("/node") || command.endsWith("\\node");

export const createChildProcessShim = (
  registry?: WasmRegistry,
  shell?: ShellService,
  workerOptions?: WorkerOptions,
) => {
  const createWorker = workerOptions?.createWorker;

  const trySpawnWorker = (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ): WorkerChildProcessImpl | undefined => {
    if (!createWorker) return undefined;
    if (!isNodeCommand(command) || args.length === 0) return undefined;
    const scriptPath = args[0];
    const workerArgs = args.slice(1);
    const worker = createWorker(scriptPath, workerArgs, envFrom(options), cwdFrom(options));
    if (!worker) return undefined;
    const child = new WorkerChildProcessImpl(worker);
    child.spawnfile = command;
    child.spawnargs = [command, ...args];
    return child;
  };

  const spawn = (
    command: string,
    args?: string[],
    options?: Record<string, unknown>,
  ): ChildProcess => {
    const argv = args ?? [];
    const workerChild = trySpawnWorker(command, argv, options);
    if (workerChild) return workerChild;
    return runChild(command, argv, registry, shell);
  };

  const fork = (
    modulePath: string,
    args?: string[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): ChildProcess => {
    if (!createWorker) throw new Error(FORK_NOT_SUPPORTED);
    const argv = Array.isArray(args) ? args : [];
    const forkOptions = args && !Array.isArray(args) ? args : options;
    const worker = createWorker(modulePath, argv, envFrom(forkOptions), cwdFrom(forkOptions));
    if (!worker) throw new Error(`createWorker returned no worker for ${modulePath}`);
    const child = new WorkerChildProcessImpl(worker);
    child.spawnfile = "node";
    child.spawnargs = ["node", modulePath, ...argv];
    return child;
  };

  /**
   * Node's default `maxBuffer` for `exec`/`execFile` (1 MiB).
   */
  const DEFAULT_MAX_BUFFER = 1024 * 1024;

  /**
   * Accumulates a child's stdout/stderr, enforcing `maxBuffer`. Node kills
   * the child and fails with `ENOBUFS` when the limit is exceeded.
   */
  const collectOutput = (
    child: ChildProcess,
    maxBuffer: number,
    onOverflow: (error: Error & { code: string; killed: boolean }) => void,
  ) => {
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    const append = (target: "out" | "err", chunk: Buffer) => {
      if (overflowed) return;
      const text = chunk.toString();
      if (target === "out") stdout += text;
      else stderr += text;
      if (stdout.length > maxBuffer || stderr.length > maxBuffer) {
        overflowed = true;
        const err = new Error(
          `stdout or stderr exceeded the maxBuffer limit of ${maxBuffer} bytes`,
        ) as Error & { code: string; killed: boolean };
        err.code = "ENOBUFS";
        err.killed = true;
        onOverflow(err);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("err", chunk));
    return {
      get overflowed() {
        return overflowed;
      },
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
    };
  };

  const exec = (command: string, options?: any, callback?: any) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options !== null ? options : {};
    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const parts = command.split(" ");
    const child = spawn(parts[0], parts.slice(1), opts);

    if (cb) {
      let done = false;
      const output = collectOutput(child, maxBuffer, (error) => {
        if (done) return;
        done = true;
        try {
          child.kill?.();
        } catch {
          /* the child may already be gone */
        }
        cb(error, output.stdout, output.stderr);
      });
      child.on("close", (code: number) => {
        if (done) return;
        done = true;
        cb(
          code === 0 ? null : Object.assign(new Error(`Command failed: ${command}\n${output.stderr}`), { code }),
          output.stdout,
          output.stderr,
        );
      });
      child.on("error", (error: Error) => {
        if (done) return;
        done = true;
        cb(error, "", "");
      });
    }

    return child;
  };

  /**
   * `execFile(file[, args][, opts][, cb])` — same dispatch as `exec` but takes
   * the executable and its argument vector separately (no shell splitting).
   * globby/del import this named export, so it must exist for the bundle to
   * link even where callers only reach it on fallback paths.
   */
  const execFile = (
    file: string,
    argsOrOptions?: string[] | Record<string, unknown> | ((...cbArgs: any[]) => void),
    optionsOrCallback?: Record<string, unknown> | ((...cbArgs: any[]) => void),
    callback?: (...cbArgs: any[]) => void,
  ): ChildProcess => {
    const argv = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const cb = [argsOrOptions, optionsOrCallback, callback].find(
      (arg) => typeof arg === "function",
    ) as ((...cbArgs: any[]) => void) | undefined;
    const options = [argsOrOptions, optionsOrCallback].find(
      (arg) => typeof arg === "object" && arg !== null,
    ) as Record<string, unknown> | undefined;
    const maxBuffer = Number(options?.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const child = spawn(file, argv, options);

    if (cb) {
      let done = false;
      const output = collectOutput(child, maxBuffer, (error) => {
        if (done) return;
        done = true;
        try {
          child.kill?.();
        } catch {
          /* the child may already be gone */
        }
        cb(error, output.stdout, output.stderr);
      });
      child.on("close", (code: number) => {
        if (done) return;
        done = true;
        const error =
          code === 0
            ? null
            : Object.assign(new Error(`Command failed: ${file}\n${output.stderr}`), { code });
        cb(error, output.stdout, output.stderr);
      });
      child.on("error", (error: Error) => {
        if (done) return;
        done = true;
        cb(error, "", "");
      });
    }

    return child;
  };

  const execSync = (): never => {
    throw new Error(SYNC_NOT_SUPPORTED);
  };

  const execFileSync = (): never => {
    throw new Error(SYNC_NOT_SUPPORTED);
  };

  const spawnSync = (): never => {
    throw new Error(SYNC_NOT_SUPPORTED);
  };

  return {
    spawn,
    exec,
    execFile,
    fork,
    execSync,
    execFileSync,
    spawnSync,
    ChildProcess: ChildProcessImpl,
  };
};

const envFrom = (options?: Record<string, unknown>): Record<string, string> | undefined => {
  if (!options || typeof options !== "object") return undefined;
  const env = options.env;
  if (!env || typeof env !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const cwdFrom = (options?: Record<string, unknown>): string | undefined => {
  if (!options || typeof options !== "object") return undefined;
  const cwd = options.cwd;
  return typeof cwd === "string" ? cwd : undefined;
};

export interface ChildProcess {
  readonly stdin: InstanceType<typeof Writable>;
  readonly stdout: InstanceType<typeof Readable>;
  readonly stderr: InstanceType<typeof Readable>;
  readonly stdio: readonly unknown[];
  readonly pid: number | undefined;
  readonly spawnfile: string;
  readonly spawnargs: readonly string[];
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  connected: boolean;
  kill(signal?: string | number): boolean;
  ref(): this;
  unref(): this;
  send?(message: unknown): boolean;
  disconnect?: () => void;
  on(event: string, handler: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}
