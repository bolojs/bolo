import {
  createEventsShim,
  createStreamShim,
  createBufferShim,
  unsupportedError,
} from "@bolojs/node-web-shims";
import { UV_ENOBUFS } from "./errno.js";

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
  exec(
    cmd: string,
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface WorkerSpawnSpec {
  /** Bundled entry file (`node <file>` / `fork(modulePath)`). */
  filename?: string;
  /** Eval'd source (`node -e`/`--eval`/`-p`/`--print`). */
  code?: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface WorkerOptions {
  createWorker?: (spec: WorkerSpawnSpec) => WorkerLike | undefined;
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
  error?: {
    code: string;
    message: string;
    errno?: number;
    syscall?: string;
    path?: string;
    spawnargs?: readonly string[];
  };
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

/**
 * Node coerces every spawn arg through ToString before exec —
 * `spawnSync(node, [file, 0, true, undefined])` delivers '0'/'true'/
 * 'undefined' to the child (test-process-exit-code-validation relies on it).
 */
const toArgv = (args: readonly unknown[] | undefined): string[] =>
  (args ?? []).map((arg) => String(arg));

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
    // `node <argv>` may carry flags (`-e`, `-pe`, `--eval`, ...) ahead of the
    // entry — parse them like the sync path does instead of treating argv[0]
    // as a filename (spawn(process.execPath, ['-pe', src]) is common in the
    // Node test suite).
    const spec = nodeRunSpec(args);
    if (spec.filename === undefined && spec.code === undefined) return undefined;
    const worker = createWorker({
      filename: spec.filename,
      code: spec.code,
      args: spec.args ?? [],
      env: envFrom(options),
      cwd: cwdFrom(options),
    });
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
    const argv = toArgv(args);
    const workerChild = trySpawnWorker(command, argv, options);
    if (workerChild) return workerChild;
    return runChild(command, argv, registry, shell);
  };

  const fork = (
    modulePath: string,
    args?: string[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ): ChildProcess => {
    if (!createWorker) throw unsupportedError("SPAWN_PROCESS", FORK_NOT_SUPPORTED);
    const argv = toArgv(Array.isArray(args) ? args : []);
    const forkOptions = args && !Array.isArray(args) ? args : options;
    const worker = createWorker({
      filename: modulePath,
      args: argv,
      env: envFrom(forkOptions),
      cwd: cwdFrom(forkOptions),
    });
    if (!worker) {
      throw unsupportedError("SPAWN_PROCESS", `createWorker returned no worker for ${modulePath}`);
    }
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
   * `node <argv>` → a run spec. `-e`/`--eval` run source directly;
   * `-p`/`--print` prints the eval result; short flags may cluster
   * (`-pe`, `-ep`, `-pie`); `--eval=`/`--print=` take inline source; other
   * bare flags are dropped (no CLI-flag surface exists in the browser
   * runtime). The first non-flag arg is the entry filename.
   */
  const nodeRunSpec = (argv: readonly string[]): SyncRunRequest => {
    const rest = [...argv];
    let print = false;
    // `node --version`/`-v` prints the compat target and exits.
    const versionSpec = (): SyncRunRequest => ({
      code: "console.log(process.version)",
      args: rest,
    });
    const takeEval = (inline: string | undefined): SyncRunRequest => {
      const src = inline !== undefined && inline !== "" ? inline : (rest.shift() ?? "");
      // Direct eval (not `(0, eval)`): the worker eval prelude's `require`,
      // `process`, `Buffer` bindings are module-scoped consts that only a
      // direct eval can see — `node -p 'require("fs")'` must work.
      const code = print ? `console.log(eval(${JSON.stringify(src)}))` : src;
      return { code, args: rest };
    };
    while (rest.length > 0) {
      const flag = rest[0];
      if (flag === "--") {
        rest.shift();
        break;
      }
      if (!flag.startsWith("-") || flag === "-") break;
      rest.shift();
      if (flag.startsWith("--")) {
        const eq = flag.indexOf("=");
        const name = eq === -1 ? flag : flag.slice(0, eq);
        const inline = eq === -1 ? undefined : flag.slice(eq + 1);
        if (name === "--eval") return takeEval(inline);
        if (name === "--print") {
          print = true;
          return takeEval(inline);
        }
        if (name === "--version") return versionSpec();
        // Other long flags (--inspect, --no-warnings, ...) have no script
        // semantics we model; skip them.
        continue;
      }
      // Short-flag cluster: 'e' consumes the script (rest of the cluster or
      // the next argv); 'p' is eval+print — it sets print and, like Node's
      // `-p script`, takes the script itself when no 'e' follows in the
      // cluster. Every other char is ignored.
      let wantsEval = false;
      for (let i = 1; i < flag.length; i++) {
        const c = flag[i];
        if (c === "e") return takeEval(flag.slice(i + 1) || undefined);
        if (c === "v") return versionSpec();
        if (c === "p") {
          print = true;
          wantsEval = true;
        }
      }
      if (wantsEval) return takeEval(undefined);
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
    if (!runSync) throw unsupportedError("SPAWN_SYNC", SYNC_NOT_SUPPORTED);
    return runSync(req);
  };

  /**
   * Node's maxBuffer failure: `error.code === 'ENOBUFS'`, `error.errno` is the
   * libuv code (-105), and `error.stdout`/`error.stderr` carry the captured
   * output (encoded per `options.encoding`) — the child is killed but the
   * bytes already read are not discarded.
   */
  const enobufsError = (
    command: string,
    stdout: unknown,
    stderr: unknown,
  ): Error & { code: string; errno: number } => {
    const err = new Error(`spawnSync ${command} ENOBUFS`) as Error & {
      code: string;
      errno: number;
      stdout?: unknown;
      stderr?: unknown;
    };
    err.code = "ENOBUFS";
    err.errno = UV_ENOBUFS;
    err.stdout = stdout;
    err.stderr = stderr;
    return err;
  };

  /** Spawn-failure error from the transport (`res.error`), Node-shaped. */
  const spawnError = (res: SyncRunResult, fallbackCommand: string): Error & { code?: string } =>
    Object.assign(new Error(res.error?.message ?? `spawnSync ${fallbackCommand} ENOENT`), {
      code: res.error?.code ?? "ENOENT",
      ...(res.error?.errno !== undefined ? { errno: res.error.errno } : {}),
      ...(res.error?.syscall !== undefined ? { syscall: res.error.syscall } : {}),
      ...(res.error?.path !== undefined ? { path: res.error.path } : {}),
      ...(res.error?.spawnargs !== undefined ? { spawnargs: res.error.spawnargs } : {}),
    });

  /** UTF-8 byte length of captured output — maxBuffer is a byte budget. */
  const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

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
    const argv = toArgv(args);
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
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    let status = res.status ?? null;
    let error: (Error & { code?: string }) | undefined;
    const out = toStdio(stdout);
    const err = toStdio(stderr);
    if (res.error) {
      error = spawnError(res, command);
    } else if (byteLength(stdout) > maxBuffer || byteLength(stderr) > maxBuffer) {
      // Node kills the child on overflow; the transport already ran it to
      // completion, so the closest faithful shape is the ENOBUFS error plus
      // the full captured output (Node keeps the bytes it already read).
      error = enobufsError(command, out, err);
      status = null;
    }

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

  /**
   * Minimal POSIX-shell word splitter for `execSync` command lines: splits on
   * unquoted whitespace, honours 'single' and "double" quotes (contents kept
   * verbatim, quotes removed) and backslash escapes outside quotes. Node runs
   * execSync through /bin/sh -c; we only need the token stream to recognise a
   * leading `node`/quoted-node invocation — anything else stays a shell line.
   *
   * `${VAR}` / `$VAR` expand from the environment, as the shell does — Node's
   * own test suite relies on it (`escapePOSIXShell` passes values through the
   * environment instead of quoting them).
   */
  const tokenizeCommandLine = (line: string, env?: Record<string, string>): string[] => {
    const tokens: string[] = [];
    let cur = "";
    let has = false;
    let quote: '"' | "'" | null = null;
    const expand = (name: string): string => env?.[name] ?? "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote === "'") {
        if (ch === "'") quote = null;
        else cur += ch;
        continue;
      }
      if (quote === '"') {
        if (ch === '"') quote = null;
        else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) {
          cur += line[++i];
        } else if (ch === "$") {
          // Parameter expansion is active inside double quotes.
          const braced = line[i + 1] === "{";
          const close = braced ? line.indexOf("}", i + 2) : -1;
          if (braced && close !== -1) {
            cur += expand(line.slice(i + 2, close));
            i = close;
            has = true;
          } else if (!braced && /[A-Za-z_]/.test(line[i + 1] ?? "")) {
            let j = i + 1;
            while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++;
            cur += expand(line.slice(i + 1, j));
            i = j - 1;
            has = true;
          } else {
            cur += ch;
          }
        } else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        has = true;
        continue;
      }
      if (ch === "\\" && i + 1 < line.length) {
        cur += line[++i];
        has = true;
        continue;
      }
      if (ch === "$") {
        const braced = line[i + 1] === "{";
        const close = braced ? line.indexOf("}", i + 2) : -1;
        if (braced && close !== -1) {
          cur += expand(line.slice(i + 2, close));
          i = close;
          has = true;
          continue;
        }
        if (!braced && /[A-Za-z_]/.test(line[i + 1] ?? "")) {
          let j = i + 1;
          while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++;
          cur += expand(line.slice(i + 1, j));
          i = j - 1;
          has = true;
          continue;
        }
      }
      if (/\s/.test(ch)) {
        if (has || cur.length > 0) {
          tokens.push(cur);
          cur = "";
          has = false;
        }
        continue;
      }
      cur += ch;
      has = true;
    }
    if (has || cur.length > 0) tokens.push(cur);
    return tokens;
  };

  const execSync = (command: string, options?: Record<string, unknown>): Buffer | string => {
    const opts = options ?? {};
    const str = String(command);
    const env = envFrom(opts);
    const parts = tokenizeCommandLine(str.trim(), env);
    const req =
      parts.length > 0 && isNodeCommand(parts[0]!)
        ? nodeRunSpec(parts.slice(1))
        : runSpecFor(str, [], true);
    req.env = env;
    req.cwd = cwdFrom(opts);
    const res = runSyncOrThrow(req);

    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";

    const encoding = typeof opts.encoding === "string" ? opts.encoding : "buffer";
    const encodeOut = (text: string) =>
      encoding === "buffer"
        ? Buffer.from(text)
        : Buffer.from(text).toString(encoding as BufferEncoding);
    if (byteLength(stdout) > maxBuffer || byteLength(stderr) > maxBuffer) {
      throw enobufsError(str, encodeOut(stdout), encodeOut(stderr));
    }
    if (res.error) {
      throw spawnError(res, str);
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
    const argv = toArgv(Array.isArray(args) ? args : []);
    const opts = ((Array.isArray(args) ? options : args) ?? {}) as Record<string, unknown>;
    const req = runSpecFor(file, argv);
    req.env = envFrom(opts);
    req.cwd = cwdFrom(opts);
    const res = runSyncOrThrow(req);

    const maxBuffer = Number(opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";

    const encoding = typeof opts.encoding === "string" ? opts.encoding : "buffer";
    const encodeOut = (text: string) =>
      encoding === "buffer"
        ? Buffer.from(text)
        : Buffer.from(text).toString(encoding as BufferEncoding);
    if (byteLength(stdout) > maxBuffer || byteLength(stderr) > maxBuffer) {
      throw enobufsError(file, encodeOut(stdout), encodeOut(stderr));
    }
    if (res.error) {
      throw spawnError(res, file);
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
