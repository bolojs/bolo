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

/**
 * Blocking child-run request the host resolves synchronously (process
 * workers: the `child.runSync` op over the sync channel — the main thread
 * spawns the child, buffers its stdio, and ships the result back while the
 * caller is parked in `Atomics.wait` / a sync XHR).
 */
export interface SyncRunRequest {
  /** Spawn a node process on a bundled file (`node <file> <args>`). */
  filename?: string;
  /** Spawn a node process on eval'd source (`node -e`/`--eval`/`-p`). */
  code?: string;
  /** Non-node command, dispatched through the wasm registry / shell. */
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  /** `command` is a whole shell line (execSync) — parse shell-side. */
  shellString?: boolean;
}

export interface SyncRunResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: { code: string; message: string };
}

export type SyncRunner = (req: SyncRunRequest) => SyncRunResult;

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
  runSync?: SyncRunner,
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
          code === 0
            ? null
            : Object.assign(new Error(`Command failed: ${command}\n${output.stderr}`), { code }),
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

  /**
   * `node <argv>` → a run-sync spec. `-e`/`--eval` run source directly;
   * `-p`/`--print` prints the eval result; other bare flags are dropped
   * (no CLI-flag surface exists in the browser runtime). The first non-flag
   * arg is the entry filename.
   */
  const nodeRunSpec = (argv: readonly string[]): SyncRunRequest => {
    const rest = [...argv];
    while (rest.length > 0 && rest[0].startsWith("-")) {
      const flag = rest.shift()!;
      if (flag === "-e" || flag === "--eval") {
        return { code: rest.shift() ?? "", args: rest };
      }
      if (flag === "-p" || flag === "--print") {
        const src = rest.shift() ?? "";
        return { code: `console.log((0, eval)(${JSON.stringify(src)}))`, args: rest };
      }
      if (flag === "-i" || flag === "--interactive") {
        return { code: "", args: rest };
      }
    }
    const filename = rest.shift();
    if (filename === undefined) return { code: "", args: [] };
    return { filename, args: rest };
  };

  /**
   * A `spawnSync`/`execFileSync`/`execSync` argv → run-sync request. Node
   * commands become filename/code specs (sibling process worker); anything
   * else is dispatched as a plain command (wasm registry / shell).
   */
  const runSpecFor = (
    command: string,
    argv: readonly string[],
    shellString = false,
  ): SyncRunRequest => {
    if (!shellString && isNodeCommand(command)) {
      return nodeRunSpec(argv);
    }
    return { command, args: argv, shellString };
  };

  const runSyncOrThrow = (req: SyncRunRequest): SyncRunResult => {
    if (!runSync) throw new Error(SYNC_NOT_SUPPORTED);
    return runSync(req);
  };

  const enobufsError = (command: string): Error & { code: string } => {
    const err = new Error(`spawnSync ${command} ENOBUFS`) as Error & { code: string };
    err.code = "ENOBUFS";
    return err;
  };

  /** `spawnSync(command[, args][, options])` — blocks on the host's
   * sync runner (sync channel → main thread) and returns Node's result
   * shape: `{ pid, output, stdout, stderr, status, signal, error? }`.
   * `options.input` (child stdin) cannot be delivered — the transport
   * ships buffered output only. */
  const spawnSync = (
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const opts = options ?? {};
    const argv = args ?? [];
    const req = runSpecFor(command, argv);
    req.env = envFrom(opts);
    req.cwd = cwdFrom(opts);
    const res = runSyncOrThrow(req);

    const encoding = typeof opts.encoding === "string" ? opts.encoding : "buffer";
    const toStdio = (text: string) =>
      encoding === "buffer"
        ? Buffer.from(text)
        : Buffer.from(text).toString(encoding as BufferEncoding);

    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    let stdout = res.stdout ?? "";
    let stderr = res.stderr ?? "";
    let status = res.status ?? null;
    let error: (Error & { code?: string }) | undefined;
    if (res.error) {
      error = Object.assign(new Error(res.error.message), { code: res.error.code });
    } else if (stdout.length > maxBuffer || stderr.length > maxBuffer) {
      // Node kills the child on overflow; the transport already ran it to
      // completion, so the closest faithful shape is the ENOBUFS error plus
      // the truncated output.
      error = enobufsError(command);
      status = null;
      stdout = stdout.slice(0, maxBuffer);
      stderr = stderr.slice(0, maxBuffer);
    }

    const out = toStdio(stdout);
    const err = toStdio(stderr);
    return {
      pid: nextPid++,
      output: [null, out, err],
      stdout: out,
      stderr: err,
      status,
      signal: res.signal ?? null,
      ...(error ? { error } : {}),
    };
  };

  const execSync = (command: string, options?: Record<string, unknown>): Buffer | string => {
    const opts = options ?? {};
    const str = String(command);
    const parts = str.trim().split(/\s+/);
    const req =
      parts.length > 0 && isNodeCommand(parts[0])
        ? nodeRunSpec(parts.slice(1))
        : runSpecFor(str, [], true);
    req.env = envFrom(opts);
    req.cwd = cwdFrom(opts);
    const res = runSyncOrThrow(req);

    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    if (stdout.length > maxBuffer || stderr.length > maxBuffer) throw enobufsError(str);

    const encoding = typeof opts.encoding === "string" ? opts.encoding : "buffer";
    const encodeOut = (text: string) =>
      encoding === "buffer"
        ? Buffer.from(text)
        : Buffer.from(text).toString(encoding as BufferEncoding);
    if (res.error) {
      throw Object.assign(new Error(res.error.message), {
        code: res.error.code,
        status: res.status,
      });
    }
    if (res.status !== 0 && res.status !== null) {
      throw Object.assign(new Error(`Command failed: ${str}`), {
        status: res.status,
        signal: res.signal ?? null,
        stdout: encodeOut(stdout),
        stderr: encodeOut(stderr),
      });
    }
    return encodeOut(stdout);
  };

  const execFileSync = (
    file: string,
    args?: readonly string[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Buffer | string => {
    const argv = Array.isArray(args) ? args : [];
    const opts = ((Array.isArray(args) ? options : args) ?? {}) as Record<string, unknown>;
    const req = runSpecFor(file, argv);
    req.env = envFrom(opts);
    req.cwd = cwdFrom(opts);
    const res = runSyncOrThrow(req);

    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    if (stdout.length > maxBuffer || stderr.length > maxBuffer) throw enobufsError(file);

    const encoding = typeof opts.encoding === "string" ? opts.encoding : "buffer";
    const encodeOut = (text: string) =>
      encoding === "buffer"
        ? Buffer.from(text)
        : Buffer.from(text).toString(encoding as BufferEncoding);
    if (res.error) {
      throw Object.assign(new Error(res.error.message), {
        code: res.error.code,
        status: res.status,
      });
    }
    if (res.status !== 0 && res.status !== null) {
      throw Object.assign(new Error(`Command failed: ${file} ${argv.join(" ")}`), {
        status: res.status,
        signal: res.signal ?? null,
        stdout: encodeOut(stdout),
        stderr: encodeOut(stderr),
      });
    }
    return encodeOut(stdout);
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
