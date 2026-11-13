import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createFsShim } from "@bolojs/node-runtime-shims";
import { createProcessOps } from "./remote-ops.js";
import { createRemoteDeps } from "./remote-objects.js";
import { decodeOpCall, encodeOpResult, marshalError } from "./rpc.js";
import type { RpcPeer } from "./rpc.js";
import { encodeResult } from "./sync-channel.js";
import type { SyncCaller } from "./sync-channel.js";
import {
  HOT_CALLBACK_METHODS,
  HOT_PROMISE_METHODS,
  HOT_SYNC_METHODS,
  VOL_SYNC_METHODS,
} from "./remote-vfs-surface.js";

/**
 * Regression coverage for the worker VFS facade: `createFsShim` (and every
 * consumer of `vfs.hot`/`vfs.vol`/`hot.promises`) must build and work
 * against the RPC facade `createRemoteDeps` produces — the crash after the
 * fs-breadth PR was the shim dereferencing real-memfs structure
 * (`hot.realpath.native`, `hot.promises`, `vfs.vol`) the facade lacked.
 *
 * The rpc stub routes async ops through the real `createProcessOps`
 * dispatch (same table main serves), so `vfs.hot.*`/`vfs.hot.promises.*`
 * op registration is exercised for real. The syncCaller stub mirrors the
 * sync ops against the same live volume (dispatch is async and cannot be
 * awaited synchronously); the registration-completeness test below covers
 * the wire-name contract for every facade-emittable op.
 */

const createFacade = (vfs: VfsBus) => {
  const dispatch = createProcessOps({ vfs });

  const rpc: RpcPeer = {
    call: (op, ...args) => dispatch(op, args) as Promise<never>,
    handle: () => false,
    serve: () => {},
    serveAny: undefined,
    reset: () => {},
  };

  const hot = vfs.hot as unknown as Record<string, (...args: any[]) => any>;
  const vol = vfs.vol as unknown as Record<string, (...args: any[]) => any>;
  const syncCaller: SyncCaller = {
    call(payload) {
      const { op, args } = decodeOpCall(payload);
      try {
        let result: unknown;
        if (op === "vfs.hot.constants") {
          result = vfs.hot.constants;
        } else if (op === "vfs.hot.readSync") {
          const [fd, buffer, offset, length, position] = args as [
            number,
            Uint8Array,
            number,
            number,
            number | null,
          ];
          result = { bytesRead: hot.readSync(fd, buffer, offset, length, position), buffer };
        } else if (op === "vfs.hot.readvSync") {
          const [fd, buffers, position] = args as [number, Uint8Array[], number | null];
          result = { bytesRead: hot.readvSync(fd, buffers, position), buffers };
        } else if (op === "vfs.hot.realpathSyncNative") {
          result = (hot.realpathSync as unknown as { native: (...a: any[]) => any }).native(
            ...args,
          );
        } else if (op.startsWith("vfs.hot.")) {
          result = hot[op.slice("vfs.hot.".length)](...args);
        } else if (op.startsWith("vfs.vol.")) {
          result = vol[op.slice("vfs.vol.".length)](...args);
        } else {
          throw new Error(`unexpected sync op: ${op}`);
        }
        // Sync-channel envelope: 0x01 || op-result (see sync-channel.ts).
        return encodeResult(encodeOpResult(true, result));
      } catch (err) {
        return encodeResult(encodeOpResult(false, marshalError(err)));
      }
    },
  };

  return createRemoteDeps({
    rpc,
    syncCaller,
    hasSandbox: false,
    hasWasmRegistry: false,
    hasShellService: false,
  });
};

describe("worker VFS facade", () => {
  it("every facade-emittable op is registered in the main-side ops table", async () => {
    const vfs = new VfsBus();
    const dispatch = createProcessOps({ vfs });
    const ops = [
      ...HOT_SYNC_METHODS.map((m) => `vfs.hot.${m}`),
      ...HOT_CALLBACK_METHODS.map((m) => `vfs.hot.${m}`),
      ...HOT_PROMISE_METHODS.map((m) => `vfs.hot.promises.${m}`),
      ...VOL_SYNC_METHODS.map((m) => `vfs.vol.${m}`),
      "vfs.hot.readSync",
      "vfs.hot.readvSync",
      "vfs.hot.read",
      "vfs.hot.readv",
      "vfs.hot.write",
      "vfs.hot.writev",
      "vfs.hot.realpathNative",
      "vfs.hot.realpathSyncNative",
      "vfs.hot.constants",
    ];
    for (const op of ops) {
      // Any error other than "unknown op" means the op is registered
      // (invalid-args errors like ENOENT are fine for this check).
      const err = await dispatch(op, []).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message ?? "", op).not.toContain("unknown op");
    }
  });

  it("createFsShim constructs against the facade (regression)", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);
    expect(typeof shim.readFileSync).toBe("function");
    expect(typeof shim.promises.readFile).toBe("function");
  });

  it("sync fs methods work through the facade", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);

    shim.mkdirSync("/nested", { recursive: true });
    shim.writeFileSync("/nested/a.txt", "facade hello");
    expect(shim.readFileSync("/nested/a.txt", "utf8")).toBe("facade hello");
    expect(shim.existsSync("/nested/a.txt")).toBe(true);
    expect(shim.statSync("/nested/a.txt").isFile()).toBe(true);
    expect(shim.readdirSync("/nested")).toContain("a.txt");

    shim.renameSync("/nested/a.txt", "/nested/b.txt");
    expect(shim.existsSync("/nested/b.txt")).toBe(true);

    shim.symlinkSync("/nested/b.txt", "/link.txt");
    expect(shim.realpathSync("/link.txt")).toBe("/nested/b.txt");
    expect(shim.realpathSync.native?.("/link.txt")).toBe("/nested/b.txt");

    expect(shim.constants.F_OK).toBe(0);
    expect(shim.F_OK).toBe(0);
  });

  it("Volume-only methods reach vol.cpSync/statfsSync", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);

    shim.mkdirSync("/src/sub", { recursive: true });
    shim.writeFileSync("/src/sub/f.txt", "nested");
    shim.cpSync("/src", "/dst", { recursive: true });
    expect(shim.readFileSync("/dst/sub/f.txt", "utf8")).toBe("nested");

    const stats = shim.statfsSync("/") as { bsize: number; blocks: number };
    expect(stats.bsize).toBeGreaterThan(0);
  });

  it("fd ops work: openSync/readSync/writeSync/closeSync and async open/read/write/close", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);

    shim.writeFileSync("/fd.txt", "hello world");
    const fd = shim.openSync("/fd.txt", "r");
    const buf = new Uint8Array(5);
    expect(shim.readSync(fd, buf, 0, 5, 0)).toBe(5);
    expect(new TextDecoder().decode(buf)).toBe("hello");
    expect(shim.fstatSync(fd).isFile()).toBe(true);
    shim.closeSync(fd);

    const wfd = shim.openSync("/fd.txt", "r+");
    expect(shim.writeSync(wfd, new TextEncoder().encode("HELLO"), 0, 5, 0)).toBe(5);
    shim.fsyncSync(wfd);
    shim.closeSync(wfd);
    expect(shim.readFileSync("/fd.txt", "utf8")).toBe("HELLO world");

    // Async fd surface (callback + promise forms via the facade's dual ops).
    const afd = await new Promise<number>((resolve, reject) => {
      shim.open("/fd.txt", "r", (err: unknown, fd: number) => (err ? reject(err) : resolve(fd)));
    });
    const abuf = new Uint8Array(5);
    const [bytesRead] = (await new Promise((resolve, reject) => {
      shim.read(afd, abuf, 0, 5, 0, (err: unknown, n: number, b: Uint8Array) =>
        err ? reject(err) : resolve([n, b]),
      );
    })) as [number, Uint8Array];
    expect(bytesRead).toBe(5);
    expect(new TextDecoder().decode(abuf)).toBe("HELLO");
    await new Promise<void>((resolve, reject) => {
      shim.close(afd, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  it("async and promises methods proxy over rpc", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);

    await shim.promises.writeFile("/p.txt", "data");
    expect(await shim.promises.readFile("/p.txt", "utf8")).toBe("data");

    await shim.promises.copyFile("/p.txt", "/q.txt");
    expect(shim.readFileSync("/q.txt", "utf8")).toBe("data");
    await shim.promises.rename("/q.txt", "/r.txt");
    expect(shim.existsSync("/r.txt")).toBe(true);

    await shim.symlink("/p.txt", "/alias.txt");
    await expect(shim.realpath("/alias.txt")).resolves.toBe("/p.txt");
    await expect((shim.realpath as any).native("/alias.txt")).resolves.toBe("/p.txt");
    await expect(shim.promises.realpath("/alias.txt")).resolves.toBe("/p.txt");

    const pstats = (await shim.promises.statfs("/")) as { bsize: number };
    expect(pstats.bsize).toBeGreaterThan(0);

    // Callback form on a hot callback method.
    await new Promise<void>((resolve, reject) => {
      shim.access("/r.txt", (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  it("members that cannot cross the boundary fail with a clear error", async () => {
    const vfs = new VfsBus();
    const shim = createFsShim(createFacade(vfs).vfs);
    shim.writeFileSync("/s.txt", "x");

    // `createReadStream` falls back to the fd-driven VfsReadStream — reads
    // work over the boundary even though hot lacks createReadStream.
    const rs = shim.createReadStream("/s.txt") as unknown as NodeJS.ReadableStream;
    expect(rs).toBeDefined();
    expect(() => shim.createWriteStream("/o.txt")).toThrow(/not supported by this VFS backend/);
    expect(() => shim.watchFile("/s.txt", () => {})).toThrow(/not supported by this VFS backend/);
    expect(() => shim.opendirSync("/")).toThrow(/not supported by this VFS backend/);
    // Deregistering a watcher that could never register is a no-op.
    expect(() => shim.unwatchFile("/s.txt")).not.toThrow();

    // `openSync`/`fstatSync`/`closeSync` cross the boundary — `promises.open`
    // returns a working FileHandle over the fd family.
    const fh = await shim.promises.open("/s.txt");
    await fh.close();
    await expect(shim.promises.opendir("/")).rejects.toThrow(/not supported by this VFS backend/);
    await expect(shim.promises.watch("/")).rejects.toThrow(/not supported by this VFS backend/);

    // The callback form surfaces the same error via errback.
    const err = await new Promise<unknown>((resolve) => {
      shim.opendir("/", (e: unknown) => resolve(e));
    });
    expect((err as Error).message).toMatch(/not supported by this VFS backend/);
  });
});
