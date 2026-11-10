import type { VfsBus } from "@bolojs/fs";
import { createEventsShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();

type FSWatcher = InstanceType<typeof EventEmitter> & { close: () => void };

export interface FsStat {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
  isSymbolicLink: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  size: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
  birthtime: Date;
}

/** Minimal stream surface — keeps the shim's `.d.ts` free of memfs internals. */
export interface FsStreamShim {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  close(callback?: (err?: unknown) => void): void;
  destroy(error?: Error): this;
  pause(): this;
  resume(): this;
  pipe<T>(dest: T, opts?: { end?: boolean }): T;
  readonly path: string | Uint8Array;
  readonly pending: boolean;
  readonly bytesRead?: number;
  readonly bytesWritten?: number;
}

/** Minimal `fs.Dir` surface (`opendir`/`opendirSync`). */
export interface FsDirShim {
  readonly path: string;
  close(): Promise<void>;
  close(callback: (err?: unknown) => void): void;
  closeSync(): void;
  read(): Promise<unknown>;
  read(callback: (err: unknown, dirent?: unknown) => void): void;
  readSync(): unknown;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

type NodeCallback = (err: unknown, ...results: any[]) => void;

/**
 * Adds a trailing Node-style `(err, result)` callback to a promise-returning
 * implementation — the call shape `fs.*` callers use.
 */
const withCallback = <A extends any[], R>(fn: (...args: A) => Promise<R>) => {
  const wrapped = (...args: any[]) => {
    const cb =
      typeof args[args.length - 1] === "function" ? (args.pop() as NodeCallback) : undefined;
    const promise = fn(...(args as A));
    if (!cb) return promise;
    promise.then(
      (r) => cb(null, r),
      (e) => cb(e),
    );
  };
  // Typed as always-promise: the callback form's `undefined` return mirrors
  // Node (where `fs.readFile(path, cb)` returns undefined too).
  return wrapped as (...args: any[]) => Promise<R>;
};

/**
 * memfs callback APIs already implement Node's exact signatures (they even
 * require the callback, like real fs). When the caller omits it we still
 * resolve a promise — the dual shape this shim has always exposed.
 */
const dual = <F extends (...args: any[]) => any>(fn: F) => {
  return (...args: any[]) => {
    if (typeof args[args.length - 1] === "function") return fn(...args);
    return new Promise((resolve, reject) => {
      fn(...args, (err: unknown, ...results: any[]) => {
        if (err) reject(err);
        else resolve(results.length <= 1 ? results[0] : results);
      });
    });
  };
};

export const createFsShim = (vfs: VfsBus) => {
  const readFileImpl = async (
    path: string,
    opts?: { encoding?: string } | string,
  ): Promise<string | Uint8Array> => {
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const result = await vfs.readFile(path);
    if (encoding === "utf8" || encoding === "utf-8") return String(result);
    return result;
  };

  const writeFileImpl = async (
    path: string,
    data: string | Uint8Array,
    _opts?: { encoding?: string },
  ): Promise<void> => {
    await vfs.writeFile(path, data);
  };

  const mkdirImpl = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.mkdir(path, opts);
  };

  const rmImpl = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.rm(path, opts);
  };

  const readdirImpl = async (path: string): Promise<string[]> => {
    const entries = await vfs.readdir(path);
    return typeof entries[0] === "string"
      ? (entries as string[])
      : (entries as { name: string }[]).map((e) => e.name);
  };

  const existsImpl = async (path: string): Promise<boolean> => {
    return await vfs.exists(path);
  };

  const statImpl = async (path: string): Promise<FsStat> => {
    // memfs (`vfs.hot`) resolves symlinks the same way Node's real fs does —
    // needed for the virtual-store layout (`node_modules/.bolo/<pkg>/...`),
    // which lives entirely in the hot layer. Only fall back to the
    // synthesized-flags path (which can't see symlinks) for cold-layer-only
    // paths, so eviction-miss reads into OPFS keep working.
    if (vfs.hot.existsSync(path)) {
      return vfs.hot.statSync(path) as unknown as FsStat;
    }

    const content = await vfs.readFile(path).catch(() => null);
    const isFile = content !== null;
    const isDirectory = Array.isArray(await vfs.readdir(path).catch(() => null));
    return {
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      size: isFile
        ? content instanceof Uint8Array
          ? content.byteLength
          : new TextEncoder().encode(content as string).byteLength
        : 0,
      mtime: new Date(),
      atime: new Date(),
      ctime: new Date(),
      birthtime: new Date(),
    };
  };

  const symlinkImpl = async (target: string, path: string, _type?: string): Promise<void> => {
    vfs.hot.symlinkSync(target, path);
  };

  const readlinkImpl = async (path: string): Promise<string> =>
    vfs.hot.readlinkSync(path) as string;

  const lstatImpl = async (path: string): Promise<FsStat> =>
    vfs.hot.lstatSync(path) as unknown as FsStat;

  const readFile = withCallback(readFileImpl);
  const writeFile = withCallback(writeFileImpl);
  const mkdir = withCallback(mkdirImpl);
  const rm = withCallback(rmImpl);
  const readdir = withCallback(readdirImpl);
  const stat = withCallback(statImpl);
  const symlink = withCallback(symlinkImpl);
  const readlink = withCallback(readlinkImpl);
  const lstat = withCallback(lstatImpl);

  // Legacy `fs.exists(path, cb)`: the callback receives the boolean result
  // itself (no err), unlike every other fs callback.
  const exists = (path: string, cb?: (exists: boolean) => void) => {
    const promise = existsImpl(path);
    if (cb) promise.then((e) => cb(e));
    else return promise;
  };

  const watch = (
    path: string,
    optsOrHandler?: { persistent?: boolean } | ((...args: any[]) => void),
    handler?: (...args: any[]) => void,
  ): FSWatcher => {
    const h = typeof optsOrHandler === "function" ? optsOrHandler : handler;
    const watcher = new EventEmitter() as FSWatcher;
    const w = vfs.watch(path, (filePath, event) => {
      watcher.emit("change", event, filePath);
      if (h) h(event, filePath);
    });
    watcher.close = () => w.close();
    return watcher;
  };

  // `vfs.hot` is the synchronous memfs volume backing this container's VFS
  // (the same one `bundleEntry`'s own VFS plugin reads from), so the *Sync
  // fs methods bundled apps expect (config loaders, `require()`-adjacent
  // code, CLIs) can be backed for real instead of throwing.
  const readFileSync = (
    path: string,
    opts?: { encoding?: string } | string,
  ): string | Uint8Array => {
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    return vfs.hot.readFileSync(path, encoding as BufferEncoding | undefined) as
      | string
      | Uint8Array;
  };

  const writeFileSync = (
    path: string,
    data: string | Uint8Array,
    opts?: { encoding?: string },
  ): void => {
    vfs.hot.writeFileSync(
      path,
      data,
      opts?.encoding ? { encoding: opts.encoding as BufferEncoding } : undefined,
    );
  };

  const mkdirSync = (path: string, opts?: { recursive?: boolean }): void => {
    vfs.hot.mkdirSync(path, opts);
  };

  const rmSync = (path: string, opts?: { recursive?: boolean }): void => {
    vfs.hot.rmSync(path, opts);
  };

  const readdirSync = (path: string): string[] => vfs.hot.readdirSync(path) as string[];

  const existsSync = (path: string): boolean => vfs.hot.existsSync(path);

  const statSync = (path: string): FsStat => vfs.hot.statSync(path) as unknown as FsStat;

  const symlinkSync = (target: string, path: string, _type?: string): void => {
    vfs.hot.symlinkSync(target, path);
  };

  const readlinkSync = (path: string): string => vfs.hot.readlinkSync(path) as string;

  const lstatSync = (path: string): FsStat => vfs.hot.lstatSync(path) as unknown as FsStat;

  // Breadth passthrough: memfs implements Node's signatures faithfully —
  // error codes, callback validation, options parsing — so the surface
  // below is a direct delegation (with a promise fallback when the callback
  // is omitted). `cpSync`/`statfsSync` live on the Volume in memfs 4.56 but
  // are not copied onto the `IFs` facade, hence `vfs.vol`.
  const hot = vfs.hot as unknown as Record<string, (...args: any[]) => any>;
  const vol = vfs.vol as unknown as Record<string, (...args: any[]) => any>;
  const hotPromises = vfs.hot.promises as unknown as Record<string, (...args: any[]) => any>;

  const realpath = Object.assign(dual(hot.realpath), {
    native: dual((hot.realpath as any).native),
  });
  const realpathSync = Object.assign(
    (path: string, opts?: unknown) => vfs.hot.realpathSync(path, opts as never) as string,
    {
      native: (path: string, opts?: unknown) =>
        (hot.realpathSync as any).native(path, opts) as string,
    },
  );

  const promises = {
    // Two-layer-aware subset (kept: reads reach OPFS-cold paths on
    // eviction miss; writes go through the bus so watchers/middleware fire).
    readFile: readFileImpl,
    writeFile: writeFileImpl,
    mkdir: mkdirImpl,
    rm: rmImpl,
    readdir: readdirImpl,
    exists: existsImpl,
    stat: statImpl,
    symlink: symlinkImpl,
    readlink: readlinkImpl,
    lstat: lstatImpl,
    // memfs FsPromises breadth — includes `open` returning a real FileHandle.
    access: (...args: any[]) => hotPromises.access(...args),
    appendFile: (...args: any[]) => hotPromises.appendFile(...args),
    chmod: (...args: any[]) => hotPromises.chmod(...args),
    chown: (...args: any[]) => hotPromises.chown(...args),
    copyFile: (...args: any[]) => hotPromises.copyFile(...args),
    cp: (...args: any[]) => hotPromises.cp(...args),
    lchmod: (...args: any[]) => hotPromises.lchmod(...args),
    lchown: (...args: any[]) => hotPromises.lchown(...args),
    link: (...args: any[]) => hotPromises.link(...args),
    lutimes: (...args: any[]) => hotPromises.lutimes(...args),
    mkdtemp: (...args: any[]) => hotPromises.mkdtemp(...args),
    open: (...args: any[]) => hotPromises.open(...args),
    opendir: (...args: any[]) => hotPromises.opendir(...args),
    realpath: (...args: any[]) => hotPromises.realpath(...args),
    rename: (...args: any[]) => hotPromises.rename(...args),
    rmdir: (...args: any[]) => hotPromises.rmdir(...args),
    statfs: (...args: any[]) => hotPromises.statfs(...args),
    truncate: (...args: any[]) => hotPromises.truncate(...args),
    unlink: (...args: any[]) => hotPromises.unlink(...args),
    utimes: (...args: any[]) => hotPromises.utimes(...args),
    watch: (...args: any[]) => hotPromises.watch(...args),
    glob: (...args: any[]) => hotPromises.glob(...args),
    constants: vfs.hot.constants,
    FileHandle: (vfs.hot.promises as unknown as { FileHandle: unknown }).FileHandle,
  };

  return {
    readFile,
    readFileSync,
    writeFile,
    writeFileSync,
    mkdir,
    mkdirSync,
    rm,
    rmSync,
    readdir,
    readdirSync,
    exists,
    existsSync,
    stat,
    statSync,
    symlink,
    symlinkSync,
    readlink,
    readlinkSync,
    lstat,
    lstatSync,
    watch,
    // Callback/promise dual surface backed by memfs directly.
    access: dual(hot.access),
    accessSync: (path: string, mode?: number) => vfs.hot.accessSync(path, mode),
    appendFile: dual(hot.appendFile),
    appendFileSync: (path: string, data: string | Uint8Array, opts?: unknown) =>
      vfs.hot.appendFileSync(path, data, opts as never),
    chmod: dual(hot.chmod),
    chmodSync: (path: string, mode: string | number) => vfs.hot.chmodSync(path, mode as never),
    chown: dual(hot.chown),
    chownSync: (path: string, uid: number, gid: number) => vfs.hot.chownSync(path, uid, gid),
    close: dual(hot.close),
    closeSync: (fd: number) => vfs.hot.closeSync(fd),
    copyFile: dual(hot.copyFile),
    copyFileSync: (src: string, dest: string, mode?: number) =>
      vfs.hot.copyFileSync(src, dest, mode),
    cp: dual(hot.cp),
    cpSync: (src: string, dest: string, opts?: unknown) => vol.cpSync(src, dest, opts),
    fchmod: dual(hot.fchmod),
    fchmodSync: (fd: number, mode: string | number) => vfs.hot.fchmodSync(fd, mode as never),
    fchown: dual(hot.fchown),
    fchownSync: (fd: number, uid: number, gid: number) => vfs.hot.fchownSync(fd, uid, gid),
    fdatasync: dual(hot.fdatasync),
    fdatasyncSync: (fd: number) => vfs.hot.fdatasyncSync(fd),
    fstat: dual(hot.fstat),
    fstatSync: (fd: number) => vfs.hot.fstatSync(fd) as unknown as FsStat,
    fsync: dual(hot.fsync),
    fsyncSync: (fd: number) => vfs.hot.fsyncSync(fd),
    ftruncate: dual(hot.ftruncate),
    ftruncateSync: (fd: number, len?: number) => vfs.hot.ftruncateSync(fd, len),
    futimes: dual(hot.futimes),
    futimesSync: (fd: number, atime: unknown, mtime: unknown) =>
      vfs.hot.futimesSync(fd, atime as never, mtime as never),
    lchmod: dual(hot.lchmod),
    lchmodSync: (path: string, mode: string | number) => vfs.hot.lchmodSync(path, mode as never),
    lchown: dual(hot.lchown),
    lchownSync: (path: string, uid: number, gid: number) => vfs.hot.lchownSync(path, uid, gid),
    link: dual(hot.link),
    linkSync: (existingPath: string, newPath: string) => vfs.hot.linkSync(existingPath, newPath),
    lutimes: dual(hot.lutimes),
    lutimesSync: (path: string, atime: unknown, mtime: unknown) =>
      vfs.hot.lutimesSync(path, atime as never, mtime as never),
    mkdtemp: dual(hot.mkdtemp),
    mkdtempSync: (prefix: string, opts?: unknown) =>
      vfs.hot.mkdtempSync(prefix, opts as never) as string,
    open: dual(hot.open),
    openSync: (path: string, flags?: string | number, mode?: string | number) =>
      vfs.hot.openSync(path, flags as never, mode as never),
    opendir: dual(hot.opendir),
    opendirSync: (path: string, opts?: unknown): FsDirShim =>
      vfs.hot.opendirSync(path, opts as never) as unknown as FsDirShim,
    read: dual(hot.read),
    readSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => vfs.hot.readSync(fd, buffer as never, offset, length, position),
    readv: dual(hot.readv),
    readvSync: (fd: number, buffers: Uint8Array[], position?: number | null) =>
      vfs.hot.readvSync(fd, buffers as never[], position),
    realpath,
    realpathSync,
    rename: dual(hot.rename),
    renameSync: (oldPath: string, newPath: string) => vfs.hot.renameSync(oldPath, newPath),
    rmdir: dual(hot.rmdir),
    rmdirSync: (path: string, opts?: unknown) => vfs.hot.rmdirSync(path, opts as never),
    statfs: dual(hot.statfs),
    statfsSync: (path: string, opts?: unknown) => vol.statfsSync(path, opts),
    truncate: dual(hot.truncate),
    truncateSync: (path: string, len?: number) => vfs.hot.truncateSync(path, len),
    unlink: dual(hot.unlink),
    unlinkSync: (path: string) => vfs.hot.unlinkSync(path),
    utimes: dual(hot.utimes),
    utimesSync: (path: string, atime: unknown, mtime: unknown) =>
      vfs.hot.utimesSync(path, atime as never, mtime as never),
    write: dual(hot.write),
    writeSync: (fd: number, buffer: Uint8Array | string, ...rest: any[]) =>
      vfs.hot.writeSync(fd, buffer as never, ...(rest as [number, number, number | null])),
    writev: dual(hot.writev),
    writevSync: (fd: number, buffers: Uint8Array[], position?: number | null) =>
      vfs.hot.writevSync(fd, buffers as never[], position),
    // Stat polling watchers (Node semantics: listener gets (curr, prev) Stats).
    watchFile: (path: string, ...args: any[]) => hot.watchFile(path, ...args),
    unwatchFile: (path: string, listener?: (...args: any[]) => void) =>
      hot.unwatchFile(path, listener),
    StatWatcher: (vfs.hot as unknown as { StatWatcher: unknown }).StatWatcher,
    // Streams backed by memfs' own stream classes (fs-node-builtins — no
    // node:stream dependency, so they work in the browser realm).
    createReadStream: (path: string, opts?: unknown): FsStreamShim =>
      vfs.hot.createReadStream(path, opts as never) as unknown as FsStreamShim,
    createWriteStream: (path: string, opts?: unknown): FsStreamShim =>
      vfs.hot.createWriteStream(path, opts as never) as unknown as FsStreamShim,
    ReadStream: (vfs.hot as unknown as { ReadStream: unknown }).ReadStream,
    WriteStream: (vfs.hot as unknown as { WriteStream: unknown }).WriteStream,
    FSWatcher: (vfs.hot as unknown as { FSWatcher: unknown }).FSWatcher,
    Stats: (vfs.hot as unknown as { Stats: unknown }).Stats,
    Dirent: (vfs.hot as unknown as { Dirent: unknown }).Dirent,
    // Full Node constants set (O_*, S_*, COPYFILE_*, access modes) — memfs
    // ships the same table as real fs.constants.
    constants: vfs.hot.constants,
    F_OK: vfs.hot.constants.F_OK,
    R_OK: vfs.hot.constants.R_OK,
    W_OK: vfs.hot.constants.W_OK,
    X_OK: vfs.hot.constants.X_OK,
    glob: dual(hot.glob),
    promises,
  };
};

export type FsShim = ReturnType<typeof createFsShim>;
