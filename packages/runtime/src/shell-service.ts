import type { VfsBus } from "@bolojs/fs";
import type { PackageManager } from "@bolojs/pm";
import type { SWSandbox } from "@bolojs/sandbox";
import { bundleEntry, resetBundler } from "@bolojs/registry";
import { createLiveShimRegistry } from "@bolojs/node-runtime-shims";
import type { SpawnedProcess } from "@bolojs/node-runtime-shims";
import { curl } from "./commands/curl.js";
import { git } from "./commands/git.js";
import { nc } from "./commands/nc.js";
import { tcping } from "./commands/tcping.js";
import { Bash } from "just-bash/browser";
import type { RuntimeWorker } from "./runtime-worker.js";
import type { SandboxBackend } from "./sandbox-backend.js";
import type { ContainerEvents } from "./events.js";
import { VfsBashFileSystem } from "./vfs-bash-fs.js";
import { superviseRun } from "./supervise-run.js";
import { NodeProcess } from "./node-process.js";
import { DEFAULT_SAB_BYTES } from "./sync-channel.js";
import type { SyncServer } from "./sync-channel.js";

declare global {
  // Populated just before executing a bundled node app so its aliased `node:*`
  // imports (see `bundleEntry`'s node-alias plugin) can bind to this
  // container's live `VfsBus`/`SWSandbox` instead of a fresh one per bundle.
  // eslint-disable-next-line no-var
  var __browserContainers:
    | {
        vfs: VfsBus;
        sandbox?: SWSandbox;
        shims: Record<string, unknown>;
        timers?: {
          setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
          clearTimeout: (t: unknown) => unknown;
          setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => unknown;
          clearInterval: (t: unknown) => unknown;
          setImmediate?: (fn: (...a: unknown[]) => void, ...rest: unknown[]) => unknown;
          clearImmediate?: (t: unknown) => unknown;
        };
      }
    | undefined;
}

export interface ShellServiceDeps {
  vfs: VfsBus;
  swSandbox?: SWSandbox;
  events?: ContainerEvents;
  packageManager: PackageManager;
  runtimeWorker: RuntimeWorker;
  sandbox?: SandboxBackend;
  workdir?: string;
  /** Max ms to wait for pending timers before reporting a node app's exit. Default 5000. */
  quiescenceCapMs?: number;
  /** Sync-channel server for process workers. When present (and `Worker`
   * exists), node apps run in a dedicated worker process instead of on the
   * main thread. */
  syncServer?: SyncServer;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface OutputCallbacks {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  /** Opaque tag identifying this execution; `kill(tag)` terminates a process
   * worker started under it. */
  tag?: unknown;
}

export interface ShellDeps {
  vfs: VfsBus;
  cwd: string;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
}

export type { OutputCallbacks };

let runCounter = 0;

/**
 * `new Worker(code, { eval: true })` runs raw source in a process worker —
 * no bundler rewrite, so the node:* surface is reached through the container
 * globals every bundled module sees (`__browserContainers.shims`).
 */
const WORKER_EVAL_PRELUDE = `const __wt = globalThis.__browserContainers.shims.worker_threads;
const { parentPort, workerData, isMainThread, MessageChannel, BroadcastChannel } = __wt;
const process = globalThis.__browserContainers.shims.process;
`;

export interface ThreadSpawnSpec {
  filename?: string;
  code?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  workerData?: unknown;
  threadId?: number;
}

export interface SpawnedThreadHandle {
  post(value: unknown): void;
  terminate(): void;
}

/**
 * Deadline for one `bundleEntry` call. Rolldown's WASM glue
 * (`@napi-rs/wasm-runtime`) sporadically throws `Atomics.wait cannot be
 * called in this context` on the page main thread; the thrown worker leaves
 * the returned promise unsettled forever, so without a ceiling a wedged
 * bundle hangs the spawn until the process-level timeout reclaims it. Well
 * below that exec budget so a wedged bundle fails fast.
 */
const BUNDLE_TIMEOUT_MS = 30_000;

export class ShellService {
  private deps: ShellServiceDeps;
  private cwd: string;
  private bash: Bash;
  private viteWatcher?: ReturnType<VfsBus["watch"]>;
  private processes = new Map<unknown, NodeProcess>();

  constructor(deps: ShellServiceDeps) {
    this.deps = deps;
    this.cwd = deps.workdir ?? "/";
    this.bash = new Bash({ fs: new VfsBashFileSystem(deps.vfs), cwd: this.cwd });
  }

  async execute(command: string, output?: Partial<OutputCallbacks>): Promise<ShellResult> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const callbacks: OutputCallbacks = {
      // Carried through so runNodeAppInWorker can register the process for kill(tag).
      tag: output?.tag,
      stdout: (data: string) => {
        stdoutChunks.push(data);
        output?.stdout?.(data);
      },
      stderr: (data: string) => {
        stderrChunks.push(data);
        output?.stderr?.(data);
      },
    };

    try {
      const exitCode = await this.route(command, callbacks);
      if (output?.tag !== undefined) this.processes.delete(output.tag);
      return {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
      };
    } catch (err) {
      if (output?.tag !== undefined) this.processes.delete(output.tag);
      const message = err instanceof Error ? err.message : String(err);
      callbacks.stderr(message);
      return {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode: 1,
      };
    }
  }

  /** Terminate a process worker started under `tag`, if one is running.
   * Returns true when a process was killed. */
  kill(tag: unknown): boolean {
    const proc = this.processes.get(tag);
    if (!proc) return false;
    this.processes.delete(tag);
    proc.kill();
    return true;
  }

  /**
   * Terminate every process worker this shell started.
   *
   * A hung worker is a leaked worker: it keeps its own realm (and the whole
   * WASM heap behind it) alive until the page is closed. The compat harness
   * reboots the container between packages, so without this every wedged
   * package leaks a worker and the renderer eventually OOMs — which kills the
   * whole run, not just the package. Returns the number of workers killed.
   */
  killAll(): number {
    const procs = [...this.processes.values()];
    this.processes.clear();
    for (const proc of procs) {
      try {
        proc.kill();
      } catch {
        /* a worker that already died must not block teardown */
      }
    }
    return procs.length;
  }

  /** Resolve a user-supplied path against the workdir. */
  private resolvePath(p: string): string {
    if (this.cwd === "/" || p.startsWith(this.cwd)) return p;
    return p.startsWith("/") ? `${this.cwd}${p}` : `${this.cwd}/${p}`;
  }

  private async route(command: string, output: OutputCallbacks): Promise<number> {
    const [cmd, ...rest] = command.trim().split(/\s+/);

    if (cmd === "npm") return this.routeNpm(rest, output);
    if (cmd === "runtime") return this.routeRuntime(rest, output);
    if (cmd === "agent") return this.routeAgent(rest, output);
    if (cmd === "curl") return curl(rest, output);
    if (cmd === "git") return git(rest, { vfs: this.deps.vfs, cwd: this.cwd, ...output });
    if (cmd === "nc") return nc(rest, output);
    if (cmd === "tcping") return tcping(rest, output);
    if (cmd === "node" || cmd === "bun") {
      const filePath = rest[0];
      if (!filePath) {
        return this.routeRepl(output);
      }
      return this.runNodeApp(filePath, output);
    }

    // just-bash restores cwd to its pre-call value after each exec(), so the
    // shell's persistent working directory is threaded through explicitly.
    const result = await this.bash.exec(command, { cwd: this.cwd });
    if (result.stdout) output.stdout(result.stdout);
    if (result.stderr) output.stderr(result.stderr);
    this.cwd = result.env.PWD ?? this.cwd;
    return result.exitCode;
  }

  private async routeNpm(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "install" && subcmd !== "i") {
      if (subcmd === "run") return this.routeNpmRun(rest, output);
      output.stderr(`Unsupported npm subcommand: ${subcmd}`);
      return 1;
    }

    try {
      if (rest.length > 0) {
        await this.deps.packageManager.install(rest);
      } else {
        await this.deps.packageManager.install();
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeNpmRun(args: string[], output: OutputCallbacks): Promise<number> {
    const scriptName = args[0];

    if (scriptName === "dev") {
      // BrowserViteServer is wired at boot, so the in-browser preview is
      // already live at /__preview/. Vite itself never spawns — running a real
      // vite inside the in-browser sandbox would just thrash on missing
      // node_modules + native APIs. Print a status so the model's mental
      // model of "npm run dev started a dev server" stays satisfied.
      output.stdout("Vite dev server: in-browser preview is live at /__preview/\n");
      return 0;
    }

    try {
      const pkgPath = this.resolvePath("package.json");
      const pkgContent = await this.deps.vfs.readFile(pkgPath);
      const pkg = JSON.parse(String(pkgContent)) as { scripts?: Record<string, string> };
      const scriptCmd = pkg.scripts?.[scriptName];
      if (!scriptCmd) {
        output.stderr(`Missing script: "${scriptName}"\n`);
        output.stderr(
          `Available scripts: ${Object.keys(pkg.scripts ?? {}).join(", ") || "(none)"}\n`,
        );
        return 1;
      }
      return this.route(scriptCmd, output);
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeRuntime(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "run") {
      output.stderr(`Unsupported runtime subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr("Usage: runtime run <script>");
      return 1;
    }

    return this.runNodeApp(filePath, output);
  }

  private async routeRepl(output: OutputCallbacks): Promise<number> {
    // ponytail: shell→REPL streaming integration post-v1; Terminal.tsx will wire ReplService directly
    this.deps.runtimeWorker.startRepl();
    output.stdout("REPL started. (streaming integration post-v1)\n");
    return 0;
  }

  /**
   * Resolves and bundles a node entry point over the VFS (see `bundleEntry`),
   * with `node:*` builtins aliased to this container's live shims, then
   * executes the self-contained bundle in the main realm via a blob import.
   * `http.createServer().listen()` inside the app fires `onPortEvent`, which
   * is forwarded through the same `events.emit('port', …)` the dev server
   * (`routeNpmRun`, above) uses, so a node server drives the preview iframe
   * identically to `npm run dev`.
   */
  /**
   * Runs a bundled node app in a dedicated process worker: real exit codes,
   * globals isolated per spawn, and `kill()`/`terminate()` that reclaims even
   * synchronous infinite loops. Used whenever `Worker` is available and a
   * sync server is configured; otherwise falls back to `runNodeAppMainThread`.
   */
  private runNodeAppInWorker(
    entry: string,
    code: string,
    output: OutputCallbacks,
    onPortEvent: (event: string, data: { port: number; url?: string }) => void,
  ): NodeProcess {
    const pid = `p${++runCounter}`;
    const scope = this.deps.swSandbox?.scope ?? "/";
    const proc = new NodeProcess({
      pid,
      vfs: this.deps.vfs,
      sandbox: this.deps.swSandbox,
      syncServer: this.deps.syncServer!,
      xhrUrl: `${scope}__bolo_sync/${pid}`,
      shellService: { exec: (cmd, cmdArgs) => this.execute([cmd, ...cmdArgs].join(" ")) },
      spawnThread: (spec, onMessage, onExit, onStdout, onStderr) =>
        this.spawnThreadProcess(spec, { onMessage, onExit, onStdout, onStderr }),
      quiescenceCapMs: this.deps.quiescenceCapMs,
      sabBytes:
        typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? DEFAULT_SAB_BYTES : 0,
    });
    proc.onStdout = output.stdout;
    proc.onStderr = output.stderr;
    proc.onPortEvent = onPortEvent;
    if (output.tag !== undefined) this.processes.set(output.tag, proc);
    void proc.exit.finally(() => {
      if (output.tag !== undefined) this.processes.delete(output.tag);
    });
    proc.run({ code, filename: entry, cwd: this.cwd });
    return proc;
  }

  /**
   * Worker-per-process worker_threads backend: a thread is a full
   * NodeProcess (bundled file, or eval code behind `WORKER_EVAL_PRELUDE`)
   * whose `parentPort`/`workerData` arrive via `PROC_RUN.thread`. Messages
   * cross as THREAD_MSG payloads both ways; the thread's stdout/stderr ride
   * the requester's streams.
   */
  private async spawnThreadProcess(
    spec: ThreadSpawnSpec,
    cbs: {
      onMessage: (value: unknown) => void;
      onExit: (code: number) => void;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<SpawnedThreadHandle> {
    let code: string;
    let filename: string;
    if (spec.code !== undefined) {
      code = WORKER_EVAL_PRELUDE + spec.code;
      filename = "<worker eval>";
    } else {
      filename = spec.filename ? this.resolvePath(spec.filename) : "<worker>";
      const bundle = await bundleEntry(filename, {
        vfs: this.deps.vfs,
        cwd: spec.cwd ?? this.cwd,
        getShim: (builtin) =>
          globalThis.__browserContainers?.shims[builtin] as Record<string, unknown> | undefined,
      });
      code = bundle.code;
    }

    const pid = `t${++runCounter}`;
    const scope = this.deps.swSandbox?.scope ?? "/";
    const proc = new NodeProcess({
      pid,
      vfs: this.deps.vfs,
      sandbox: this.deps.swSandbox,
      syncServer: this.deps.syncServer!,
      xhrUrl: `${scope}__bolo_sync/${pid}`,
      shellService: { exec: (cmd, cmdArgs) => this.execute([cmd, ...cmdArgs].join(" ")) },
      // Threads themselves can spawn threads — the same op path recurses.
      spawnThread: (s, onMessage, onExit, onStdout, onStderr) =>
        this.spawnThreadProcess(s, { onMessage, onExit, onStdout, onStderr }),
      quiescenceCapMs: this.deps.quiescenceCapMs,
      sabBytes:
        typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? DEFAULT_SAB_BYTES : 0,
    });
    proc.onStdout = cbs.onStdout ?? null;
    proc.onStderr = cbs.onStderr ?? null;
    proc.onThreadMessage = cbs.onMessage;
    const tag = `thread:${pid}`;
    this.processes.set(tag, proc);
    void proc.exit.then(cbs.onExit).finally(() => this.processes.delete(tag));
    proc.run({
      code,
      filename,
      args: [...(spec.args ?? [])],
      env: spec.env,
      cwd: spec.cwd ?? this.cwd,
      thread: { workerData: spec.workerData, threadId: spec.threadId },
    });
    return {
      post: (v) => proc.postToThread(v),
      terminate: () => proc.kill(),
    };
  }

  /**
   * Synchronous-spawn facade for `createLiveShimRegistry`'s `spawnProcess`:
   * thread spin-up (bundling, worker boot) is async behind the scenes, so
   * messages posted before the process is live are queued and flushed.
   */
  private spawnProcessForShim = (spec: ThreadSpawnSpec): SpawnedProcess => {
    let onMessage: ((v: unknown) => void) | null = null;
    let onExit: ((c: number) => void) | null = null;
    let onError: ((e: unknown) => void) | null = null;
    let onStdout: ((d: string) => void) | null = null;
    let onStderr: ((d: string) => void) | null = null;
    let handle: SpawnedThreadHandle | null = null;
    const queue: unknown[] = [];
    void this.spawnThreadProcess(spec, {
      onMessage: (v) => onMessage?.(v),
      onExit: (c) => onExit?.(c),
      onStdout: (d) => onStdout?.(d),
      onStderr: (d) => onStderr?.(d),
    }).then(
      (h) => {
        handle = h;
        for (const m of queue.splice(0)) h.post(m);
      },
      (err) => onError?.(err),
    );
    return {
      postMessage: (v) => (handle ? handle.post(v) : queue.push(v)),
      terminate: () => handle?.terminate(),
      setOnStdout: (cb) => {
        onStdout = cb;
      },
      setOnStderr: (cb) => {
        onStderr = cb;
      },
      setOnMessage: (cb) => {
        onMessage = cb;
      },
      setOnExit: (cb) => {
        onExit = cb;
      },
      setOnError: (cb) => {
        onError = cb;
      },
    };
  };

  private async runNodeApp(filePath: string, rawOutput: OutputCallbacks): Promise<number> {
    // Drop output after the program has terminated (e.g. code following
    // process.exit() that already started running).
    let terminated = false;
    const output: OutputCallbacks = {
      ...rawOutput,
      stdout: (d) => {
        if (!terminated) rawOutput.stdout(d);
      },
      stderr: (d) => {
        if (!terminated) rawOutput.stderr(d);
      },
    };
    try {
      let serving = false;
      const onPortEvent = (event: string, data: { port: number; url?: string }) => {
        const url = data.url ?? "";
        if (event === "server-ready") this.deps.events?.emit("server-ready", data.port, url);
        if (event === "port-open") {
          serving = true;
          this.deps.events?.emit("port", data.port, "open", url);
        }
        if (event === "port-close") this.deps.events?.emit("port", data.port, "close", url);
      };

      // User files are written under the workdir but referenced with paths
      // relative to it (e.g. '/server.ts' → '/home/web/server.ts').
      const entry = this.resolvePath(filePath);

      const shims = createLiveShimRegistry({
        vfs: this.deps.vfs,
        sandbox: this.deps.swSandbox,
        onPortEvent,
        shellService: { exec: (cmd, cmdArgs) => this.execute([cmd, ...cmdArgs].join(" ")) },
        cwd: this.cwd,
        argv: ["node", entry],
        onStdout: output.stdout,
        onStderr: output.stderr,
        // worker_threads/fork on the main realm spawn real process workers —
        // only where the process-worker infrastructure exists.
        spawnProcess:
          this.deps.syncServer && typeof Worker === "function"
            ? this.spawnProcessForShim
            : undefined,
      });
      globalThis.__browserContainers = {
        vfs: this.deps.vfs,
        sandbox: this.deps.swSandbox,
        shims,
      };

      let bundleTimer: ReturnType<typeof setTimeout> | undefined;
      const { code, warnings } = await Promise.race([
        bundleEntry(entry, {
          vfs: this.deps.vfs,
          cwd: this.cwd,
          getShim: (builtin) =>
            globalThis.__browserContainers?.shims[builtin] as Record<string, unknown> | undefined,
        }),
        new Promise<never>((_resolve, reject) => {
          bundleTimer = setTimeout(() => {
            // The bundler's WASM instance may be poisoned (Atomics.wait
            // poison) — drop the cached module handles so the next call
            // re-initialises instead of reusing the wedged one.
            resetBundler();
            reject(
              new Error(
                `bundleEntry timed out after ${BUNDLE_TIMEOUT_MS}ms — bundler wedged, module cache reset`,
              ),
            );
          }, BUNDLE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(bundleTimer));
      for (const warning of warnings) output.stderr(`[bundle warning] ${warning}\n`);

      if (this.deps.syncServer && typeof Worker === "function") {
        const proc = this.runNodeAppInWorker(entry, code, output, onPortEvent);
        const exitCode = await proc.exit;
        terminated = true;
        return exitCode;
      }

      const result = await superviseRun({
        process: shims.process as Parameters<typeof superviseRun>[0]["process"],
        stderr: output.stderr,
        isServing: () => serving,
        quiescenceCapMs: this.deps.quiescenceCapMs,
        run: async () => {
          // Identical source would hit the module cache and never re-execute.
          const unique = `\n//# bolo-run=${++runCounter}`;
          const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(code + unique)}`;
          const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
            default?: { fetch?: (req: Request) => Promise<Response> };
          };
          // Hono/workers-style: if the module exports a default with a `.fetch`
          // method, auto-register it as a fetch handler so the server starts
          // without an explicit http.createServer().listen() call.
          const exportedApp = mod?.default;
          if (exportedApp && typeof exportedApp.fetch === "function" && this.deps.swSandbox) {
            this.deps.swSandbox.onFetch(exportedApp.fetch.bind(exportedApp));
            onPortEvent("server-ready", { port: 3000, url: "https://sandbox.local" });
            onPortEvent("port-open", { port: 3000, url: "https://sandbox.local" });
          }
        },
      });
      terminated = result.terminated;
      return result.exitCode;
    } catch (err) {
      terminated = false;
      rawOutput.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  private async routeAgent(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd !== "run") {
      output.stderr(`Unsupported agent subcommand: ${subcmd}`);
      return 1;
    }

    const filePath = rest[0];
    if (!filePath) {
      output.stderr("Usage: agent run <script>");
      return 1;
    }

    try {
      if (!this.deps.sandbox) {
        output.stderr("No sandbox configured for agent code");
        return 1;
      }
      const code = String(await this.deps.vfs.readFile(filePath));
      const result = await this.deps.sandbox.run(code);
      if (result.error) {
        output.stderr(result.error);
        return 1;
      }
      if (result.result) {
        output.stdout(result.result);
      }
      return 0;
    } catch (err) {
      output.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
}
