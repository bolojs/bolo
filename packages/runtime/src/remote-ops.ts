import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import type { WasmRegistry, ShellService } from "@bolojs/node-runtime-shims";
import { getLogger } from "@bolojs/log/browser";
import {
  HOT_CALLBACK_METHODS,
  HOT_PROMISE_METHODS,
  HOT_SYNC_METHODS,
  VOL_SYNC_METHODS,
} from "./remote-vfs-surface.js";

const logger = getLogger(["bolo", "runtime", "remote-ops"]);

export interface ProcessOpsDeps {
  readonly vfs: VfsBus;
  readonly sandbox?: SWSandbox;
  readonly wasmRegistry?: WasmRegistry;
  readonly shellService?: ShellService;
  /**
   * Worker-thread/fork spawn service. `spawn` receives the spec plus two
   * remote callbacks (rpc `$cb`s arrive already unmarshal'd): `onMessage`
   * for each value the thread posts up, `onExit` with the exit code.
   */
  readonly threads?: {
    spawn(
      spec: {
        filename?: string;
        code?: string;
        args?: readonly string[];
        env?: Record<string, string>;
        cwd?: string;
        workerData?: unknown;
        threadId?: number;
      },
      onMessage: (value: unknown) => void,
      onExit: (code: number) => void,
      onStdout?: (data: string) => void,
      onStderr?: (data: string) => void,
    ): Promise<{ post(value: unknown): void; terminate(): void }>;
  };
}

export type OpDispatch = (op: string, args: unknown[]) => Promise<unknown>;

type PlainRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
};

type PlainResponse = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
};

const requestToPlain = async (req: Request): Promise<PlainRequest> => ({
  url: req.url,
  method: req.method,
  headers: Object.fromEntries(req.headers.entries()),
  body:
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : new Uint8Array(await req.arrayBuffer()),
});

const plainToResponse = (plain: PlainResponse): Response =>
  new Response(plain.body ? (plain.body.slice().buffer as ArrayBuffer) : null, {
    status: plain.status ?? 200,
    statusText: plain.statusText,
    headers: plain.headers,
  });

/**
 * Main-side op table for one process worker. The same dispatch serves the
 * async postMessage RPC (ops may take marshalled callback args, already
 * unmarshal'd into functions by the rpc peer) and the synchronous channel
 * (JSON args, no callbacks).
 *
 * Ops: `vfs.*` async ops, `vfs.hot.*` sync volume ops, `vfs.watch`/`vfs.on`
 * subscriptions, `sandbox.onFetch` registration, `wasm.dispatch`,
 * `shell.exec`.
 */
export const createProcessOps = (deps: ProcessOpsDeps): OpDispatch => {
  const { vfs, sandbox, wasmRegistry, shellService } = deps;
  const subscriptions = new Map<number, { close: () => void }>();
  let nextSub = 1;

  const ops: Record<string, (...args: any[]) => unknown> = {
    "vfs.readFile": (path: string) => vfs.readFile(path),
    "vfs.writeFile": (path: string, content: string | Uint8Array) => vfs.writeFile(path, content),
    "vfs.mkdir": (path: string, opts?: { recursive?: boolean }) => vfs.mkdir(path, opts),
    "vfs.rm": (path: string, opts?: { recursive?: boolean; force?: boolean }) => vfs.rm(path, opts),
    "vfs.exists": (path: string) => vfs.exists(path),
    "vfs.readdir": async (path: string, opts?: { withFileTypes?: boolean }) => {
      const entries = await vfs.readdir(path, opts);
      // DirEnt predicate methods don't survive marshalling; ship the flags.
      if (opts?.withFileTypes) {
        return (entries as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>).map(
          (e) => ({ name: e.name, __de: 1, f: e.isFile(), d: e.isDirectory() }),
        );
      }
      return entries;
    },
    "vfs.rename": (oldPath: string, newPath: string) => vfs.rename(oldPath, newPath),
    "vfs.snapshot": () => vfs.snapshot(),
    "vfs.restore": (snap: Record<string, unknown>) => vfs.restore(snap),

    "vfs.watch": (glob: string, cb: (path: string, event: string) => void) => {
      const watcher = vfs.watch(glob, (path, event) => void cb(path, event));
      const id = nextSub++;
      subscriptions.set(id, watcher);
      return id;
    },
    "vfs.on": (
      event: "write" | "delete" | "rename",
      cb: (e: { type: string; path: string }) => void,
    ) => {
      vfs.on(event, (e) => void cb(e));
      // VfsBus.on does not return an unsubscribe handle; track nothing.
      return 0;
    },
    "vfs.unwatch": (id: number) => {
      subscriptions.get(id)?.close();
      subscriptions.delete(id);
    },
  };

  // Synchronous volume ops — reachable over the sync channel as
  // `vfs.hot.<method>` (and over async RPC too; they're sync on main).
  const hot = vfs.hot as unknown as Record<string, (...args: any[]) => any>;
  for (const method of HOT_SYNC_METHODS) {
    if (typeof hot[method] === "function") {
      ops[`vfs.hot.${method}`] = (...args: unknown[]) => hot[method](...args);
    }
  }

  // Buffer-mutating sync ops: the result carries the bytes back so the
  // facade can copy them into the caller's buffer (args arrive by value).
  if (typeof hot.readSync === "function") {
    ops["vfs.hot.readSync"] = (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => ({ bytesRead: hot.readSync(fd, buffer, offset, length, position), buffer });
  }
  if (typeof hot.readvSync === "function") {
    ops["vfs.hot.readvSync"] = (fd: number, buffers: Uint8Array[], position?: number | null) => ({
      bytesRead: hot.readvSync(fd, buffers, position),
      buffers,
    });
  }

  // Callback-style async ops — served over async RPC (`vfs.hot.<method>`).
  // memfs requires the trailing Node callback, so each op injects one and
  // resolves the single result (Node's extra result args — e.g. the buffer
  // in read/write — are handled by the dedicated ops below or dropped;
  // callers only use the scalar).
  for (const method of HOT_CALLBACK_METHODS) {
    if (typeof hot[method] === "function") {
      ops[`vfs.hot.${method}`] = (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          hot[method](...args, (err: unknown, ...results: unknown[]) => {
            if (err) reject(err);
            else resolve(results.length <= 1 ? results[0] : results);
          });
        });
    }
  }

  // realpath's `.native` variants ship as flat-named ops. Call through the
  // parent function object so any receiver binding survives.
  const realpathFn = hot.realpath as { native?: (...args: any[]) => any } | undefined;
  if (typeof realpathFn?.native === "function") {
    ops["vfs.hot.realpathNative"] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        realpathFn.native!(...args, (err: unknown, result: unknown) =>
          err ? reject(err) : resolve(result),
        );
      });
  }
  const realpathSyncFn = hot.realpathSync as { native?: (...args: any[]) => any } | undefined;
  if (typeof realpathSyncFn?.native === "function") {
    ops["vfs.hot.realpathSyncNative"] = (...args: unknown[]) => realpathSyncFn.native!(...args);
  }

  // fd-family async ops with buffer results that must round-trip.
  if (typeof hot.read === "function") {
    ops["vfs.hot.read"] = (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) =>
      new Promise((resolve, reject) => {
        hot.read(fd, buffer, offset, length, position, (err: unknown, n: number, b: unknown) =>
          err ? reject(err) : resolve({ bytesRead: n, buffer: b }),
        );
      });
  }
  if (typeof hot.readv === "function") {
    ops["vfs.hot.readv"] = (fd: number, buffers: Uint8Array[], position?: number | null) =>
      new Promise((resolve, reject) => {
        hot.readv(fd, buffers, position, (err: unknown, n: number, bufs: unknown) =>
          err ? reject(err) : resolve({ bytesRead: n, buffers: bufs }),
        );
      });
  }
  if (typeof hot.write === "function") {
    ops["vfs.hot.write"] = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        hot.write(...args, (err: unknown, n: number) =>
          err ? reject(err) : resolve({ bytesWritten: n }),
        );
      });
  }
  if (typeof hot.writev === "function") {
    ops["vfs.hot.writev"] = (fd: number, buffers: Uint8Array[], position?: number | null) =>
      new Promise((resolve, reject) => {
        hot.writev(fd, buffers, position, (err: unknown, n: number) =>
          err ? reject(err) : resolve({ bytesWritten: n }),
        );
      });
  }

  // `hot.promises.*` — async RPC only. Methods returning live objects
  // (FileHandle, Dir, AsyncIterator) are deliberately not served.
  const hotPromises = vfs.hot.promises as unknown as
    | Record<string, (...args: any[]) => Promise<unknown>>
    | undefined;
  if (hotPromises) {
    for (const method of HOT_PROMISE_METHODS) {
      if (typeof hotPromises[method] === "function") {
        ops[`vfs.hot.promises.${method}`] = (...args: unknown[]) => hotPromises[method](...args);
      }
    }
  }

  // The full Node constants table is plain JSON — ship it verbatim.
  ops["vfs.hot.constants"] = () => vfs.hot.constants;

  // Volume-only methods the memfs IFs facade does not carry.
  const vol = vfs.vol as unknown as Record<string, (...args: any[]) => any> | undefined;
  if (vol) {
    for (const method of VOL_SYNC_METHODS) {
      if (typeof vol[method] === "function") {
        ops[`vfs.vol.${method}`] = (...args: unknown[]) => vol[method](...args);
      }
    }
  }

  if (sandbox) {
    ops["sandbox.onFetch"] = (cb: (plain: PlainRequest) => Promise<PlainResponse>) => {
      sandbox.onFetch(async (req) => plainToResponse(await cb(await requestToPlain(req))));
      return 0;
    };
  }

  if (wasmRegistry) {
    ops["wasm.dispatch"] = (command: string, args: string[]) =>
      wasmRegistry.dispatch(command, args);
  }
  if (shellService) {
    ops["shell.exec"] = (command: string, args: string[], cwd?: string) =>
      shellService.exec(command, args, cwd);
  }

  // Synchronous child-process requests (`spawnSync`/`execSync`/`execFileSync`).
  // The worker blocks on the sync channel while the main thread either spawns
  // a sibling process worker (node specs: `filename`/`code`) or dispatches the
  // command through the wasm registry / bash service, then ships the buffered
  // stdout/stderr/exit status back. No callbacks can cross the sync channel,
  // so stdio returns whole and stdin input is not delivered.
  ops["child.runSync"] = async (req: {
    filename?: string;
    code?: string;
    command?: string;
    args?: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    /** `command` is a full shell line (execSync) — route to the shell, not wasm. */
    shellString?: boolean;
  }) => {
    if (req.filename !== undefined || req.code !== undefined) {
      const threads = deps.threads;
      if (!threads) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          signal: null,
          error: {
            code: "ENOSYS",
            message: "spawning a child node process requires a spawn service",
          },
        };
      }
      let stdout = "";
      let stderr = "";
      const status = await new Promise<number>((resolve, reject) => {
        threads
          .spawn(
            {
              filename: req.filename,
              code: req.code,
              args: req.args,
              env: req.env,
              cwd: req.cwd,
            },
            () => {},
            resolve,
            (d: string) => {
              stdout += d;
            },
            (d: string) => {
              stderr += d;
            },
          )
          .then(() => {}, reject);
      });
      return { status, stdout, stderr, signal: null };
    }

    const command = req.command ?? "";
    const cmdArgs = [...(req.args ?? [])];
    // POSIX shells report a missing executable as exit 127 + "not found" on
    // stderr; Node's spawnSync surfaces that as an ENOENT error object with
    // libuv errno metadata instead of a plain status.
    const enoent = (stdout: string, stderr: string) => ({
      status: null,
      stdout,
      stderr,
      signal: null,
      error: {
        code: "ENOENT",
        errno: -2,
        syscall: `spawnSync ${command}`,
        path: command,
        spawnargs: cmdArgs,
        message: `spawnSync ${command} ENOENT`,
      },
    });
    const looksMissing = (exitCode: number, stderr: string) =>
      exitCode === 127 && /not found/i.test(stderr);

    if (wasmRegistry && !req.shellString) {
      const result = await wasmRegistry.dispatch(command, cmdArgs);
      const fellThrough =
        result.exitCode !== 0 && result.stderr.includes("WASM tool not found") && shellService;
      if (!fellThrough) {
        if (looksMissing(result.exitCode, result.stderr)) {
          return enoent(result.stdout, result.stderr);
        }
        return {
          status: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          signal: null,
        };
      }
    }
    if (shellService) {
      const result = await shellService.exec(command, cmdArgs, req.cwd);
      if (looksMissing(result.exitCode, result.stderr)) {
        return enoent(result.stdout, result.stderr);
      }
      return {
        status: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: null,
      };
    }
    return enoent("", "");
  };

  if (deps.threads) {
    const threads = deps.threads;
    const spawned = new Map<number, { post(v: unknown): void; terminate(): void }>();
    let nextThreadHandle = 1;
    ops["thread.spawn"] = async (
      spec: Parameters<typeof threads.spawn>[0],
      onMessage: (v: unknown) => void,
      onExit: (code: number) => void,
      onStdout?: (data: string) => void,
      onStderr?: (data: string) => void,
    ) => {
      let id = 0;
      const handle = await threads.spawn(
        spec,
        onMessage,
        (code) => {
          spawned.delete(id);
          onExit(code);
        },
        onStdout,
        onStderr,
      );
      id = nextThreadHandle++;
      spawned.set(id, handle);
      return id;
    };
    ops["thread.send"] = (id: number, value: unknown) => {
      spawned.get(id)?.post(value);
      return 0;
    };
    ops["thread.terminate"] = (id: number) => {
      const handle = spawned.get(id);
      spawned.delete(id);
      handle?.terminate();
      return 0;
    };
  }

  return async (op, args) => {
    const handler = ops[op];
    if (!handler) {
      logger.warn("unknown process op", { op });
      throw new Error(`unknown op: ${op}`);
    }
    return handler(...args);
  };
};
