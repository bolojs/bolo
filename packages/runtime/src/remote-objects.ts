import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import { getLogger } from "@bolojs/log/browser";
import type { RpcPeer } from "./rpc.js";
import { decodeOpResult, encodeOpCall } from "./rpc.js";
import { decodeResponse } from "./sync-channel.js";
import type { SyncCaller } from "./sync-channel.js";
import {
  HOT_CALLBACK_METHODS,
  HOT_PROMISE_METHODS,
  HOT_STAT_METHODS,
  HOT_SYNC_METHODS,
  VOL_SYNC_METHODS,
} from "./remote-vfs-surface.js";

const logger = getLogger(["bolo", "runtime", "remote-objects"]);

/**
 * Worker-side remote dependencies for `createLiveShimRegistry`: a `VfsBus`
 * whose async methods RPC to the main thread and whose `hot` volume resolves
 * synchronously over the sync channel, plus remote `sandbox`, `wasmRegistry`
 * and `shellService` facades.
 */

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFBLK = 0o060000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

// memfs Stats cross the wire as plain JSON; Node's fs.Stats predicate
// methods are derived from st_mode so they can be reconstructed here.
const reviveStat = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const stat = raw as Record<string, unknown>;
  const mode = (stat.mode as number) ?? 0;
  const kind = mode & S_IFMT;
  return Object.assign(stat, {
    isFile: () => kind === S_IFREG,
    isDirectory: () => kind === S_IFDIR,
    isSymbolicLink: () => kind === S_IFLNK,
    isBlockDevice: () => kind === S_IFBLK,
    isCharacterDevice: () => kind === S_IFCHR,
    isFIFO: () => kind === S_IFIFO,
    isSocket: () => kind === S_IFSOCK,
  });
};

type NodeCb = (err: unknown, ...results: any[]) => void;

/** A view over `buffer` regardless of the ArrayBufferView subtype passed. */
const asU8 = (buffer: unknown): Uint8Array => {
  if (buffer instanceof Uint8Array) return buffer;
  const view = buffer as { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
};

/** Worker→main synchronous child-run request (`child_process.*Sync`). */
export interface SyncRunRequest {
  filename?: string;
  code?: string;
  command?: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
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

export interface RemoteDeps {
  vfs: VfsBus;
  sandbox: SWSandbox | undefined;
  wasmRegistry: { dispatch: (command: string, args: string[]) => Promise<unknown> } | undefined;
  shellService:
    | {
        exec: (
          command: string,
          args: string[],
          cwd?: string,
        ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      }
    | undefined;
  /** Blocking worker→main child run (`child.runSync` op over the sync channel). */
  spawnSync: (req: SyncRunRequest) => SyncRunResult;
  /** Number of fetch handlers registered via sandbox.onFetch — a listening
   * server is a live handle that keeps the process alive. */
  fetchHandlerCount: () => number;
}

export interface RemoteDepsOptions {
  rpc: RpcPeer;
  syncCaller: SyncCaller;
  hasSandbox: boolean;
  hasWasmRegistry: boolean;
  hasShellService: boolean;
}

export const createRemoteDeps = (opts: RemoteDepsOptions): RemoteDeps => {
  const { rpc, syncCaller } = opts;
  let fetchHandlers = 0;

  const syncOp = (op: string, args: unknown[]): unknown =>
    decodeOpResult(decodeResponse(syncCaller.call(encodeOpCall(op, args))));

  // Dual-shaped async op: supports both `fn(...args)` → Promise and
  // `fn(...args, cb)` Node-style — the same contract memfs' own callback
  // API has, so `dual()` in the fs shim wraps it transparently.
  const asyncOp = (op: string, revive: boolean) => {
    const fn = (...args: unknown[]) => {
      const cb = typeof args[args.length - 1] === "function" ? (args.pop() as NodeCb) : undefined;
      const p = rpc.call(op, ...args).then((r) => (revive ? reviveStat(r) : r));
      if (!cb) return p;
      p.then(
        (r) => cb(null, r),
        (e) => cb(e),
      );
      return undefined;
    };
    return fn;
  };

  const hot: Record<string, unknown> = {};
  for (const m of HOT_SYNC_METHODS) {
    hot[m] = (...args: unknown[]) => {
      const result = syncOp(`vfs.hot.${m}`, args);
      return HOT_STAT_METHODS.has(m) ? reviveStat(result) : result;
    };
  }
  for (const m of HOT_CALLBACK_METHODS) {
    hot[m] = asyncOp(`vfs.hot.${m}`, HOT_STAT_METHODS.has(m));
  }

  // Buffer-mutating fd ops: the op ships the bytes back alongside the scalar
  // result; copy them into the caller's buffer (sync channel passes by value).
  hot.readSync = (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    const res = syncOp("vfs.hot.readSync", [fd, buffer, offset, length, position]) as {
      bytesRead: number;
      buffer: Uint8Array;
    };
    asU8(buffer).set(res.buffer);
    return res.bytesRead;
  };
  hot.readvSync = (fd: number, buffers: Uint8Array[], position?: number | null) => {
    const res = syncOp("vfs.hot.readvSync", [fd, buffers, position]) as {
      bytesRead: number;
      buffers: Uint8Array[];
    };
    res.buffers.forEach((b, i) => {
      if (buffers[i]) asU8(buffers[i]).set(b);
    });
    return res.bytesRead;
  };

  // Node's fs.read/write callbacks receive (err, result, buffer) — keep the
  // pair so `dual()` resolves the same tuple real memfs produces.
  hot.read = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as NodeCb) : undefined;
    const [fd, buffer, offset, length, position] = args as [
      number,
      Uint8Array,
      number,
      number,
      number | null,
    ];
    const p = rpc.call("vfs.hot.read", fd, buffer, offset, length, position).then((res) => {
      const r = res as { bytesRead: number; buffer: Uint8Array };
      asU8(buffer).set(r.buffer);
      return [r.bytesRead, buffer] as [number, Uint8Array];
    });
    if (!cb) return p;
    p.then(
      ([n, b]) => cb(null, n, b),
      (e) => cb(e),
    );
    return undefined;
  };
  hot.readv = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as NodeCb) : undefined;
    const [fd, buffers, position] = args as [number, Uint8Array[], number | null | undefined];
    const p = rpc.call("vfs.hot.readv", fd, buffers, position).then((res) => {
      const r = res as { bytesRead: number; buffers: Uint8Array[] };
      r.buffers.forEach((b, i) => {
        if (buffers[i]) asU8(buffers[i]).set(b);
      });
      return [r.bytesRead, buffers] as [number, Uint8Array[]];
    });
    if (!cb) return p;
    p.then(
      ([n, b]) => cb(null, n, b),
      (e) => cb(e),
    );
    return undefined;
  };
  hot.write = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as NodeCb) : undefined;
    const p = rpc
      .call("vfs.hot.write", ...args)
      .then((res) => [(res as { bytesWritten: number }).bytesWritten, args[1]]);
    if (!cb) return p;
    p.then(
      ([n, b]) => cb(null, n, b),
      (e) => cb(e),
    );
    return undefined;
  };
  hot.writev = (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as NodeCb) : undefined;
    const [fd, buffers, position] = args as [number, Uint8Array[], number | null | undefined];
    const p = rpc
      .call("vfs.hot.writev", fd, buffers, position)
      .then((res) => [(res as { bytesWritten: number }).bytesWritten, buffers]);
    if (!cb) return p;
    p.then(
      ([n, b]) => cb(null, n, b),
      (e) => cb(e),
    );
    return undefined;
  };

  // realpath's `.native` sub-methods arrive as flat-named ops.
  hot.realpath = Object.assign(hot.realpath as (...args: unknown[]) => unknown, {
    native: asyncOp("vfs.hot.realpathNative", false),
  });
  hot.realpathSync = Object.assign(hot.realpathSync as (...args: unknown[]) => unknown, {
    native: (...args: unknown[]) => syncOp("vfs.hot.realpathSyncNative", args),
  });

  // `hot.promises` proxies via async RPC. Members that cannot cross the
  // boundary (FileHandle, Dir, watch/glob iterators) stay absent — the fs
  // shim feature-detects and throws a clear error for them.
  const hotPromises: Record<string, unknown> = {};
  for (const m of HOT_PROMISE_METHODS) {
    hotPromises[m] = (...args: unknown[]) => rpc.call(`vfs.hot.promises.${m}`, ...args);
  }
  hot.promises = hotPromises;

  // Plain-JSON constants table, fetched lazily on first access and cached.
  let constantsCache: unknown;
  Object.defineProperty(hot, "constants", {
    enumerable: true,
    get: () => (constantsCache ??= syncOp("vfs.hot.constants", [])),
  });

  // Volume-only methods the memfs IFs facade does not carry (cpSync/statfsSync).
  const vol: Record<string, unknown> = {};
  for (const m of VOL_SYNC_METHODS) {
    vol[m] = (...args: unknown[]) => syncOp(`vfs.vol.${m}`, args);
  }

  const vfs = {
    hot,
    vol,
    readFile: (path: string) => rpc.call("vfs.readFile", path),
    writeFile: (path: string, content: unknown) => rpc.call("vfs.writeFile", path, content),
    mkdir: (path: string, o?: { recursive?: boolean }) => rpc.call("vfs.mkdir", path, o),
    rm: (path: string, o?: { recursive?: boolean; force?: boolean }) => rpc.call("vfs.rm", path, o),
    exists: (path: string) => rpc.call("vfs.exists", path),
    readdir: async (path: string, o?: { withFileTypes?: boolean }) => {
      const entries = (await rpc.call("vfs.readdir", path, o)) as unknown[];
      if (!o?.withFileTypes) return entries;
      return (entries as Array<{ name: string; __de?: number; f?: boolean; d?: boolean }>).map(
        (e) => ({
          name: e.name,
          isFile: () => e.f === true,
          isDirectory: () => e.d === true,
        }),
      );
    },
    rename: (a: string, b: string) => rpc.call("vfs.rename", a, b),
    snapshot: () => rpc.call("vfs.snapshot"),
    restore: (snap: unknown) => rpc.call("vfs.restore", snap),
    watch: (glob: string, handler: (path: string, event: string) => void) => {
      const closed = { current: false };
      const idPromise = rpc.call<number>("vfs.watch", glob, (path: string, event: string) => {
        if (!closed.current) handler(path, event);
      });
      return {
        close: () => {
          closed.current = true;
          void idPromise.then((id) => rpc.call("vfs.unwatch", id)).catch(() => {});
        },
      };
    },
    on: (event: string, handler: (e: unknown) => void) => {
      void rpc.call("vfs.on", event, handler).catch((err) => {
        logger.warn("vfs.on registration failed", { error: String(err) });
      });
    },
    // Middleware cannot cross the boundary; fail loudly rather than no-op.
    use: () => {
      throw new Error("vfs.use is not supported in a process worker");
    },
    destroy: () => {
      /* per-process remote view; the real VfsBus outlives it */
    },
  } as unknown as VfsBus;

  const sandbox = opts.hasSandbox
    ? ({
        // The registered handler is invoked main-side with a real Request;
        // we re-materialize one inside the worker so the http shim sees the
        // genuine fetch API surface (req.body, headers.entries(), arrayBuffer).
        onFetch: (handler: (req: Request) => Promise<Response>) => {
          fetchHandlers++;
          void rpc
            .call(
              "sandbox.onFetch",
              async (plain: {
                url: string;
                method: string;
                headers: Record<string, string>;
                body?: Uint8Array;
              }) => {
                const hasBody = plain.body && plain.method !== "GET" && plain.method !== "HEAD";
                const req = new Request(plain.url, {
                  method: plain.method,
                  headers: plain.headers,
                  body: hasBody ? plain.body!.slice().buffer : undefined,
                });
                const res = await handler(req);
                const buf = res.body ? new Uint8Array(await res.arrayBuffer()) : undefined;
                return {
                  status: res.status,
                  statusText: res.statusText,
                  headers: Object.fromEntries(res.headers.entries()),
                  body: buf,
                };
              },
            )
            .catch((err) => {
              logger.warn("sandbox.onFetch registration failed", { error: String(err) });
            });
        },
      } as unknown as SWSandbox)
    : undefined;

  return {
    vfs,
    sandbox,
    fetchHandlerCount: () => fetchHandlers,
    spawnSync: (req: SyncRunRequest) => syncOp("child.runSync", [req]) as SyncRunResult,
    wasmRegistry: opts.hasWasmRegistry
      ? {
          dispatch: (command: string, args: string[]) =>
            rpc.call("wasm.dispatch", command, args) as Promise<never>,
        }
      : undefined,
    shellService: opts.hasShellService
      ? {
          exec: (command: string, args: string[], cwd?: string) =>
            rpc.call("shell.exec", command, args, cwd) as Promise<never>,
        }
      : undefined,
  };
};
