import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import { getLogger } from "@bolojs/log/browser";
import type { RpcPeer } from "./rpc.js";
import { decodeOpResult, encodeOpCall } from "./rpc.js";
import { decodeResponse } from "./sync-channel.js";
import type { SyncCaller } from "./sync-channel.js";

const logger = getLogger(["bolo", "runtime", "remote-objects"]);

/**
 * Worker-side remote dependencies for `createLiveShimRegistry`: a `VfsBus`
 * whose async methods RPC to the main thread and whose `hot` volume resolves
 * synchronously over the sync channel, plus remote `sandbox`, `wasmRegistry`
 * and `shellService` facades.
 */

// The subset of the memfs volume `hot` that shims call. Must stay in sync
// with the op list in remote-ops.ts.
const HOT_METHODS = [
  "readFileSync",
  "writeFileSync",
  "mkdirSync",
  "rmSync",
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "symlinkSync",
  "readlinkSync",
  "renameSync",
  "copyFileSync",
  "chmodSync",
  "appendFileSync",
  "realpathSync",
  "utimesSync",
  "truncateSync",
  "unlinkSync",
  "rmdirSync",
  "accessSync",
  "mkdtempSync",
] as const;

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

const STAT_OPS = new Set(["statSync", "lstatSync"]);

export interface RemoteDeps {
  vfs: VfsBus;
  sandbox: SWSandbox | undefined;
  wasmRegistry: { dispatch: (command: string, args: string[]) => Promise<unknown> } | undefined;
  shellService: { exec: (command: string, args: string[]) => Promise<unknown> } | undefined;
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

  const hot: Record<string, unknown> = {};
  for (const m of HOT_METHODS) {
    hot[m] = (...args: unknown[]) => {
      const result = syncOp(`vfs.hot.${m}`, args);
      return STAT_OPS.has(m) ? reviveStat(result) : result;
    };
  }

  const vfs = {
    hot,
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
    wasmRegistry: opts.hasWasmRegistry
      ? {
          dispatch: (command: string, args: string[]) =>
            rpc.call("wasm.dispatch", command, args) as Promise<never>,
        }
      : undefined,
    shellService: opts.hasShellService
      ? {
          exec: (command: string, args: string[]) =>
            rpc.call("shell.exec", command, args) as Promise<never>,
        }
      : undefined,
  };
};
