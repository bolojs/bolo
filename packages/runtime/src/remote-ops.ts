import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import type { WasmRegistry, ShellService } from "@bolojs/node-runtime-shims";
import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "runtime", "remote-ops"]);

export interface ProcessOpsDeps {
  readonly vfs: VfsBus;
  readonly sandbox?: SWSandbox;
  readonly wasmRegistry?: WasmRegistry;
  readonly shellService?: ShellService;
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
  const hot = vfs.hot as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of [
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
  ]) {
    if (typeof hot[method] === "function") {
      ops[`vfs.hot.${method}`] = (...args: unknown[]) => hot[method](...args);
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
    ops["shell.exec"] = (command: string, args: string[]) => shellService.exec(command, args);
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
