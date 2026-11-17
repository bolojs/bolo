import type { VfsBus } from "@bolojs/fs";
import type { PackageManager } from "@bolojs/pm";
import type { SWSandbox } from "@bolojs/sandbox";
import {
  bundleEntry,
  resetBundler,
  bundleHasNativeAddon,
  createWasmNativeAddonLoader,
  warmWasmAddons,
  wasmAddonSpecifiers,
} from "@bolojs/registry";
import { BOLO_NODE_VERSION, createLiveShimRegistry } from "@bolojs/node-runtime-shims";
import { setOkExpressionSourceReader } from "@bolojs/node-web-shims/dist/util/ok-expression.js";
import { createBundleSourcemapReader } from "@bolojs/node-web-shims/dist/util/bundle-sourcemap.js";
import type { NativeAddonLoader, SpawnedProcess, WasmRegistry } from "@bolojs/node-runtime-shims";
import { curl } from "./commands/curl.js";
import { git } from "./commands/git.js";
import { nc } from "./commands/nc.js";
import { tcping } from "./commands/tcping.js";
import { Bash } from "just-bash/browser";
import type { RuntimeWorker } from "./runtime-worker.js";
import type { SandboxBackend } from "./sandbox-backend.js";
import type { ContainerEvents } from "./events.js";
import { VfsBashFileSystem } from "./vfs-bash-fs.js";
import { joinShellArgs, splitShellArgs } from "./shell-words.js";
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
  /**
   * WASM tool registry for `child_process` dispatch and direct shell
   * commands (esbuild/swc curated tools). When absent, wasm dispatch is
   * skipped and commands fall through to just-bash.
   */
  wasmRegistry?: WasmRegistry;
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
const WORKER_EVAL_PRELUDE = `const __shims = globalThis.__browserContainers.shims;
const __wt = __shims.worker_threads;
const { parentPort, workerData, isMainThread, MessageChannel, BroadcastChannel } = __wt;
const process = __shims.process;
const console = __shims.console;
const { Buffer } = __shims.buffer;
// node -e snippets reach builtins through the same createRequire the
// module shim exposes (no static bundler resolution in eval code).
const require = __shims.module.createRequire("/");
// Process workers inject handle-tracked timers so eval'd timers keep the
// process alive; elsewhere real globals (which the main-realm supervisor
// patches for quiescence tracking).
const __timers = globalThis.__browserContainers.timers;
const setTimeout = __timers?.setTimeout ?? globalThis.setTimeout;
const clearTimeout = __timers?.clearTimeout ?? globalThis.clearTimeout;
const setInterval = __timers?.setInterval ?? globalThis.setInterval;
const clearInterval = __timers?.clearInterval ?? globalThis.clearInterval;
const setImmediate = __timers?.setImmediate ?? ((fn, ...a) => globalThis.setTimeout(fn, 0, ...a));
const clearImmediate = __timers?.clearImmediate ?? ((h) => globalThis.clearTimeout(h));
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

const NODE_USAGE = `Node ${BOLO_NODE_VERSION} (in-browser)
Usage: node <file.js>      run a JS/TS file in the container
       node -e <code>      evaluate a string (alias: --eval)
       node --version      print the Node version
       node                start the REPL
`;

const NPM_USAGE = `Usage: npm install [pkg ...]   install packages (alias: npm i)
       npm run <script>     run a package.json script
`;

const NPX_USAGE = `Usage: npx <tool> [args...]  run a tool from node_modules/.bin or a wasm tool
       npx --version       print the npm version
`;

/** npm version bundled with the Node release BOLO_NODE_VERSION tracks (22.12 → npm 10.9). */
const BOLO_NPM_VERSION = "10.9.0";

const HELP_TEXT = `bolo shell — available commands

  help                     this message (help <cmd> for details)
  node <file.js>           run a JS/TS file (bun works too); node -e evals a string
  npm install [pkg ...]    install packages
  npm run <script>         run a package.json script
  npx <tool>               run a tool from node_modules/.bin or a wasm tool
  runtime run <file>       run a file on the runtime
  agent run <file>         run a file in the agent sandbox
  curl  git  nc  tcping    network + git on the virtual fs
  sleep <secs>

Shell builtins (just-bash): ls cd pwd cat echo cp mv rm mkdir touch
find grep sed awk jq head tail sort tar gzip which clear history ...
Run '<cmd> --help' for details on any of these.

Servers you start get a preview URL in the preview pane.
`;

/**
 * Bundle cache for `spawnThreadProcess` — `child_process.spawnSync` of a
 * node script re-bundles the same entry on every call (Node's own test
 * suite spawns a script dozens of times), and each rolldown pass costs
 * ~1.3s of main-thread time. Keyed by resolved filename; invalidated when
 * the file's mtime changes so edits after the first spawn still take.
 */
interface CachedBundle {
  code: string;
  mtimeMs: number;
}
const bundleCache = new Map<string, CachedBundle>();

const mtimeOf = (vfs: VfsBus, path: string): number => {
  try {
    return vfs.hot.statSync(path).mtimeMs ?? 0;
  } catch {
    return -1;
  }
};

const bundleWithCache = async (
  vfs: VfsBus,
  filename: string,
  cwd: string,
): Promise<{ code: string }> => {
  const mtime = mtimeOf(vfs, filename);
  const cached = bundleCache.get(filename);
  if (cached && cached.mtimeMs === mtime) return { code: cached.code };
  const { code } = await bundleEntry(filename, {
    vfs,
    cwd,
    getShim: (builtin) =>
      globalThis.__browserContainers?.shims[builtin] as Record<string, unknown> | undefined,
  });
  bundleCache.set(filename, { code, mtimeMs: mtime });
  return { code };
};

export class ShellService {
  private deps: ShellServiceDeps;
  private cwd: string;
  private bash: Bash;
  private viteWatcher?: ReturnType<VfsBus["watch"]>;
  private processes = new Map<unknown, NodeProcess>();
  /**
   * Tags killed before their process worker registered (a `node app.js`
   * killed while `bundleEntry` is still running). runNodeApp checks this set
   * after bundling so a killed spawn doesn't start — and orphan — a server
   * with no live kill handle.
   */
  private killedTags = new Set<unknown>();
  /**
   * Warmed `.node` → WASM-variant exports, populated lazily by
   * `ensureWasmAddons()` the first time a bundle contains a `.node` require.
   * The map is mutated in place so the synchronous `nativeAddonLoader`
   * closure created in the constructor sees late arrivals.
   */
  private readonly wasmAddons: Record<string, unknown> = {};
  private wasmAddonsWarm: Promise<void> | undefined;
  private readonly nativeAddonLoader: NativeAddonLoader;

  constructor(deps: ShellServiceDeps) {
    this.deps = deps;
    this.cwd = deps.workdir ?? "/";
    this.bash = new Bash({ fs: new VfsBashFileSystem(deps.vfs), cwd: this.cwd });
    this.nativeAddonLoader = createWasmNativeAddonLoader({
      vfs: deps.vfs,
      addons: this.wasmAddons,
    });
  }

  /**
   * Imports the curated `.node` variant packages (argon2-wasm,
   * lightningcss-wasm, bcryptjs) into `this.wasmAddons`. Idempotent; only
   * runs when a bundled app actually contains a `.node` require so ordinary
   * spawns never pay the CDN cost.
   */
  private ensureWasmAddons(): Promise<void> {
    this.wasmAddonsWarm ??= warmWasmAddons(wasmAddonSpecifiers()).then((warmed) => {
      Object.assign(this.wasmAddons, warmed);
    });
    return this.wasmAddonsWarm;
  }

  async execute(
    command: string,
    output?: Partial<OutputCallbacks>,
    cwd?: string,
  ): Promise<ShellResult> {
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
      const exitCode = await this.route(command, callbacks, cwd);
      if (output?.tag !== undefined) {
        this.processes.delete(output.tag);
        this.killedTags.delete(output.tag);
      }
      return {
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
      };
    } catch (err) {
      if (output?.tag !== undefined) {
        this.processes.delete(output.tag);
        this.killedTags.delete(output.tag);
      }
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
    if (!proc) {
      // No worker under this tag — either nothing killable is running (npm,
      // just-bash) or a node app is still bundling. Remember the tag so the
      // post-bundle check in runNodeApp aborts instead of orphaning a worker.
      this.killedTags.add(tag);
      return false;
    }
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

  private async route(command: string, output: OutputCallbacks, cwd?: string): Promise<number> {
    // Tokenize (not whitespace-split) so quoting survives the argv boundary:
    // `git commit -m "a b c"` must reach the git builtin as one `-m` arg.
    const [cmd = "", ...rest] = splitShellArgs(command.trim());
    // A scoped cwd (child_process spawnSync/execSync `cwd` option) applies to
    // this command only — it must not leak into the shell's persistent cwd.
    const effectiveCwd = cwd ?? this.cwd;

    if (cmd === "help") return this.routeHelp(rest, output);
    if (cmd === "npm") return this.routeNpm(rest, output);
    if (cmd === "npx") return this.routeNpx(rest, output);
    if (cmd === "runtime") return this.routeRuntime(rest, output);
    if (cmd === "agent") return this.routeAgent(rest, output);
    if (cmd === "curl") return curl(rest, output);
    if (cmd === "git") return git(rest, { vfs: this.deps.vfs, cwd: effectiveCwd, ...output });
    if (cmd === "nc") return nc(rest, output);
    if (cmd === "tcping") return tcping(rest, output);
    if (cmd === "sleep") return this.routeSleep(rest, output);
    if (cmd === "node" || cmd === "bun") return this.routeNode(rest, output);

    // WASM tool dispatch (esbuild/swc and friends) sits between the builtin
    // commands and just-bash, mirroring the "WASM tool not found" fallthrough
    // contract child-process-shim/remote-ops use: an unregistered command
    // falls through to the shell untouched. Compound commands (pipes,
    // redirects, lists, substitutions) always stay on the shell — the wasm
    // tools take argv, not shell syntax.
    if (this.deps.wasmRegistry && !/[|><&;`$]/.test(command)) {
      const result = await this.deps.wasmRegistry.dispatch(cmd, rest);
      const fellThrough = result.exitCode !== 0 && result.stderr.includes("WASM tool not found");
      if (!fellThrough) {
        if (result.stdout) output.stdout(result.stdout);
        if (result.stderr) output.stderr(result.stderr);
        return result.exitCode;
      }
    }

    // just-bash restores cwd to its pre-call value after each exec(), so the
    // shell's persistent working directory is threaded through explicitly.
    const result = await this.bash.exec(command, { cwd: effectiveCwd });
    if (result.stdout) output.stdout(result.stdout);
    // just-bash reports misses as "bash: <cmd>: command not found" — point
    // the user at the help builtin so the surface is discoverable.
    const stderr =
      result.exitCode === 127
        ? result.stderr.replaceAll("command not found", "command not found — type 'help'")
        : result.stderr;
    if (stderr) output.stderr(stderr);
    if (cwd === undefined) this.cwd = result.env.PWD ?? this.cwd;
    return result.exitCode;
  }

  /**
   * GNU `sleep` — just-bash has no builtin for it, but core-tests spawn
   * `sleep 0` through child_process. Seconds may be fractional; invalid or
   * negative intervals fail like coreutils (exit 1 + diagnostic).
   */
  private async routeSleep(args: string[], output: OutputCallbacks): Promise<number> {
    const secs = Number(args[0] ?? "");
    if (!Number.isFinite(secs) || secs < 0) {
      output.stderr(`sleep: invalid time interval '${args[0] ?? ""}'\n`);
      return 1;
    }
    if (secs > 0) await new Promise((resolve) => setTimeout(resolve, secs * 1000));
    return 0;
  }

  private routeHelp(args: string[], output: OutputCallbacks): Promise<number> {
    const topic = args[0];
    if (topic === "node" || topic === "bun") output.stdout(NODE_USAGE);
    else if (topic === "npm") output.stdout(NPM_USAGE);
    else if (topic === "npx") output.stdout(NPX_USAGE);
    else output.stdout(HELP_TEXT);
    return Promise.resolve(0);
  }

  private async routeNode(args: string[], output: OutputCallbacks): Promise<number> {
    const first = args[0];
    if (!first) {
      return this.routeRepl(output);
    }
    // `node --version`/`-v` prints the compat target and exits — there is
    // no real binary, so the shimmed process.version is the answer.
    if (first === "--version" || first === "-v") {
      output.stdout(`${BOLO_NODE_VERSION}\n`);
      return 0;
    }
    if (first === "--help" || first === "-h") {
      output.stdout(NODE_USAGE);
      return 0;
    }
    // `node -e <code>` / `node --eval <code>` (also `--eval=<code>`): run the
    // snippet behind WORKER_EVAL_PRELUDE in a process worker when the
    // process-model infra exists, else in the main realm — either way
    // builtins resolve through the prelude's createRequire.
    if (first === "-e" || first === "--eval" || first.startsWith("--eval=")) {
      const inline = first.startsWith("--eval=") ? first.slice("--eval=".length) : undefined;
      const source = inline ?? args[1];
      if (source === undefined) {
        output.stderr(`node: ${first} requires an argument\n`);
        return 9;
      }
      return this.runNodeEval(source, args.slice(inline === undefined ? 2 : 1), output);
    }
    if (first === "-") {
      output.stderr("node: reading a script from stdin is not supported in the browser sandbox\n");
      return 1;
    }
    if (first.startsWith("-")) {
      // Mirrors real Node's "bad option" diagnostic (exit 9) instead of
      // treating the flag as a filename and failing on ENOENT.
      output.stderr(`node: bad option: ${first}\n`);
      return 9;
    }
    return this.runNodeApp(first, output, args.slice(1));
  }

  private async routeNpx(args: string[], output: OutputCallbacks): Promise<number> {
    const [tool, ...toolArgs] = args;

    if (tool === undefined || tool === "--help" || tool === "-h") {
      output.stdout(NPX_USAGE);
      return 0;
    }
    if (tool === "--version" || tool === "-v") {
      output.stdout(`${BOLO_NPM_VERSION}\n`);
      return 0;
    }
    if (tool.startsWith("-")) {
      output.stderr(`npx: unsupported option: ${tool}\n`);
      return 1;
    }

    // Local install first, like real npx: node_modules/.bin/<tool> is the
    // package bin link the installer writes — run it as a node entry.
    // resolvePath keeps cwd "/" results relative; the memfs volume and the
    // bundler both need the absolute form.
    const binPath = this.resolvePath(`node_modules/.bin/${tool}`);
    const absBinPath = binPath.startsWith("/") ? binPath : `/${binPath}`;
    if (this.deps.vfs.hot.existsSync(absBinPath)) {
      return this.runNodeApp(absBinPath, output, toolArgs);
    }

    // Then the curated wasm-tool registry (esbuild, swc): same "WASM tool
    // not found" fallthrough contract as the bare-command dispatch above.
    if (this.deps.wasmRegistry) {
      const result = await this.deps.wasmRegistry.dispatch(tool, toolArgs);
      const fellThrough = result.exitCode !== 0 && result.stderr.includes("WASM tool not found");
      if (!fellThrough) {
        if (result.stdout) output.stdout(result.stdout);
        if (result.stderr) output.stderr(result.stderr);
        return result.exitCode;
      }
    }

    output.stderr(
      `npx: '${tool}' not found — install it with \`npm install ${tool}\` or use a wasm tool (esbuild, swc)\n`,
    );
    return 1;
  }

  private async routeNpm(args: string[], output: OutputCallbacks): Promise<number> {
    const [subcmd, ...rest] = args;

    if (subcmd === undefined || subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
      output.stdout(NPM_USAGE);
      return 0;
    }

    if (subcmd !== "install" && subcmd !== "i") {
      if (subcmd === "run") return this.routeNpmRun(rest, output);
      output.stderr(`Unsupported npm subcommand: ${subcmd}\n`);
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
      output.stdout(
        `Vite dev server: in-browser preview is live at ${this.deps.swSandbox?.scope ?? "/"}__preview/\n`,
      );
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

    if (subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
      output.stdout("Usage: runtime run <script>\n");
      return 0;
    }

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
    output.stdout(`Node ${BOLO_NODE_VERSION}. Usage: node <file.js> — or 'node --help'\n`);
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
    args?: string[],
  ): NodeProcess {
    const pid = `p${++runCounter}`;
    const scope = this.deps.swSandbox?.scope ?? "/";
    const proc = new NodeProcess({
      pid,
      vfs: this.deps.vfs,
      sandbox: this.deps.swSandbox,
      syncServer: this.deps.syncServer!,
      xhrUrl: `${scope}__bolo_sync/${pid}`,
      wasmRegistry: this.deps.wasmRegistry,
      shellService: {
        exec: (cmd, cmdArgs, cwd) => this.execute(joinShellArgs([cmd, ...cmdArgs]), undefined, cwd),
      },
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
    proc.run({ code, filename: entry, args, cwd: this.cwd });
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
      const bundle = await bundleWithCache(this.deps.vfs, filename, spec.cwd ?? this.cwd);
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
      wasmRegistry: this.deps.wasmRegistry,
      shellService: {
        exec: (cmd, cmdArgs, cwd) => this.execute(joinShellArgs([cmd, ...cmdArgs]), undefined, cwd),
      },
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

  private async runNodeApp(
    filePath: string,
    rawOutput: OutputCallbacks,
    scriptArgs: string[] = [],
  ): Promise<number> {
    // User files are written under the workdir but referenced with paths
    // relative to it (e.g. '/server.ts' → '/home/web/server.ts').
    const entry = this.resolvePath(filePath);
    return this.runNodeProgram({
      filename: entry,
      argv: ["node", entry, ...scriptArgs],
      scriptArgs,
      output: rawOutput,
      loadCode: () => this.bundleEntryTimed(entry),
    });
  }

  /**
   * `node -e`/`--eval`: no bundler pass — the snippet runs raw behind
   * WORKER_EVAL_PRELUDE, which wires process/console/Buffer/require/timers
   * from the live shim registry. Same process-worker/main-realm split as a
   * bundled app.
   */
  private async runNodeEval(
    source: string,
    evalArgs: string[],
    rawOutput: OutputCallbacks,
  ): Promise<number> {
    return this.runNodeProgram({
      filename: "[eval]",
      argv: ["node", ...evalArgs],
      scriptArgs: evalArgs,
      output: rawOutput,
      loadCode: async () => ({ code: WORKER_EVAL_PRELUDE + source, warnings: [] }),
    });
  }

  private async bundleEntryTimed(entry: string): Promise<{ code: string; warnings: string[] }> {
    let bundleTimer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
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
  }

  private async runNodeProgram(spec: {
    filename: string;
    argv: string[];
    /** Args after the entry — appended to argv in the process worker. */
    scriptArgs: string[];
    output: OutputCallbacks;
    loadCode: () => Promise<{ code: string; warnings?: string[] }>;
  }): Promise<number> {
    const rawOutput = spec.output;
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
        // Worker realms mint root-relative virtual URLs ("/__virtual__/..")
        // because the remote SWSandbox proxy cannot expose `.scope`; rewrite
        // them under the real scope so the scoped worker intercepts them.
        const scope = this.deps.swSandbox?.scope ?? "/";
        const rawUrl = data.url ?? "";
        const url =
          rawUrl.startsWith("/") && !rawUrl.startsWith(scope) ? scope + rawUrl.slice(1) : rawUrl;
        if (event === "server-ready") this.deps.events?.emit("server-ready", data.port, url);
        if (event === "port-open") {
          serving = true;
          this.deps.events?.emit("port", data.port, "open", url);
        }
        if (event === "port-close") this.deps.events?.emit("port", data.port, "close", url);
      };

      const entry = spec.filename;

      const shims = createLiveShimRegistry({
        vfs: this.deps.vfs,
        sandbox: this.deps.swSandbox,
        onPortEvent,
        shellService: {
          exec: (cmd, cmdArgs, cwd) =>
            this.execute(joinShellArgs([cmd, ...cmdArgs]), undefined, cwd),
        },
        cwd: this.cwd,
        argv: spec.argv,
        onStdout: output.stdout,
        onStderr: output.stderr,
        // worker_threads/fork on the main realm spawn real process workers —
        // only where the process-worker infrastructure exists.
        spawnProcess:
          this.deps.syncServer && typeof Worker === "function"
            ? this.spawnProcessForShim
            : undefined,
        // `.node` requires inside bundled deps resolve through the curated
        // WASM-variant table; variants warm lazily on first use (see
        // ensureWasmAddons, triggered after bundleEntry below).
        nativeAddonLoader: this.nativeAddonLoader,
      });
      globalThis.__browserContainers = {
        vfs: this.deps.vfs,
        sandbox: this.deps.swSandbox,
        shims,
      };

      const { code, warnings } = await spec.loadCode();
      for (const warning of warnings ?? []) output.stderr(`[bundle warning] ${warning}\n`);

      // Killed (Ctrl+C / exec timeout) while the bundle was resolving —
      // starting the app now would spawn a worker no kill handle can reach.
      if (rawOutput.tag !== undefined && this.killedTags.has(rawOutput.tag)) {
        terminated = true;
        return 1;
      }

      if (this.deps.syncServer && typeof Worker === "function") {
        // Process workers are separate realms — they warm their own addon
        // variants inside node-process-worker.ts; nothing to do here.
        const proc = this.runNodeAppInWorker(entry, code, output, onPortEvent, spec.scriptArgs);
        const exitCode = await proc.exit;
        terminated = true;
        return exitCode;
      }

      // Main-realm execution: a bundle containing `.node` requires needs the
      // variant packages warm before the code runs — the loader is
      // synchronous. Quoted-specifier probe; bundles without native addons
      // skip the CDN fetch entirely. A warm failure is not fatal: the
      // synchronous loader throws a catalogued error if a `.node` require
      // actually executes, and false-positive probes (a ".node" string in
      // user code) must not kill an otherwise runnable bundle.
      if (bundleHasNativeAddon(code)) {
        await this.ensureWasmAddons().catch((err: unknown) => {
          output.stderr(
            `[wasm-addons] variant warm-up failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
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
          // See node-process-worker: map bundle frames back to VFS sources
          // for assert.ok's falsy-expression message.
          const okReader = createBundleSourcemapReader(code, (f) => f === moduleUrl);
          if (okReader) setOkExpressionSourceReader(okReader);
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

    if (subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
      output.stdout("Usage: agent run <script>\n");
      return 0;
    }

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
