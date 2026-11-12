import type { VfsBus } from "@bolojs/fs";
import { createBufferShim, createEventsShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (same
// declaration-emit quirk as child-process-shim.ts) — read it off the value.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

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

// Mirrors Node's ERR_INVALID_ARG_TYPE phrasing.
const describeReceived = (value: unknown): string => {
  if (value == null) return ` Received ${value}`;
  if (typeof value === "function") return ` Received function ${value.name}`;
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    return name ? ` Received an instance of ${name}` : " Received [Object: null prototype]";
  }
  let shown = String(typeof value === "symbol" ? value.toString() : value);
  if (typeof value === "string") shown = `'${value}'`;
  if (typeof value === "bigint") shown = `${value}n`;
  return ` Received type ${typeof value} (${shown})`;
};

const invalidArgType = (name: string, expected: string, actual: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${name}" argument must be of type ${expected}.${describeReceived(actual)}`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

/**
 * Node's path argument type: `string | Buffer | URL` — fd-taking methods
 * (`readFile`/`writeFile`/`appendFile`/`stat`-family accept an open file
 * descriptor too) get `allowFd`. Validation must happen synchronously in the
 * public wrapper — Node throws before any callback/IO is scheduled.
 */
const validatePath = (path: unknown, name = "path", allowFd = false): void => {
  const ok =
    typeof path === "string" ||
    path instanceof Uint8Array ||
    path instanceof URL ||
    (allowFd && typeof path === "number" && Number.isInteger(path) && path >= 0);
  if (!ok) {
    throw invalidArgType(
      name,
      allowFd
        ? "one of string, Buffer, URL, or integer"
        : "one of string, Buffer, or URL",
      path,
    );
  }
};

/** Normalize a Node path arg to the VFS's string form (URL → file path, Buffer → utf8). */
const pathOf = (path: string | Uint8Array | URL): string =>
  typeof path === "string" ? path : path instanceof URL ? path.pathname : Buffer.from(path).toString();

/** Node's writeFile/appendFile data type: string, Buffer/TypedArray/DataView, or iterable. */
const validateWriteData = (data: unknown): void => {
  const ok =
    typeof data === "string" ||
    data instanceof Uint8Array ||
    ArrayBuffer.isView(data) ||
    data instanceof ArrayBuffer ||
    (data !== null &&
      typeof data === "object" &&
      (Symbol.iterator in data || Symbol.asyncIterator in data));
  if (!ok) {
    throw invalidArgType(
      "data",
      "one of string, Buffer, TypedArray, DataView, or an iterable",
      data,
    );
  }
};

export const createFsShim = (vfs: VfsBus) => {
  const readFileImpl = async (
    path: string | number,
    opts?: { encoding?: string } | string,
  ): Promise<string | Uint8Array> => {
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    // An open fd is served by the sync volume directly (Node reads the fd
    // position, same as fs.readFileSync(fd)).
    if (typeof path === "number") {
      const out = vfs.hot.readFileSync(path, encoding as BufferEncoding | undefined) as
        | string
        | Uint8Array;
      return typeof out === "string" ? out : Buffer.from(out);
    }
    // Hot-layer files read through memfs so the no-encoding result is a real
    // Buffer (Node parity — `vfs.readFile` returns a utf8 string).
    if (vfs.hot.existsSync(path)) {
      const out = vfs.hot.readFileSync(path, encoding as BufferEncoding | undefined) as
        | string
        | Uint8Array;
      return typeof out === "string" ? out : Buffer.from(out);
    }
    // Cold-layer (OPFS) fallthrough: eviction misses and cold-only paths.
    const result = await vfs.readFile(path);
    const buf = result instanceof Uint8Array ? Buffer.from(result) : Buffer.from(String(result));
    if (encoding !== undefined && encoding !== null) {
      return buf.toString(encoding as BufferEncoding);
    }
    return buf;
  };

  const writeFileImpl = async (
    path: string | number,
    data: string | Uint8Array,
    opts?: { encoding?: string; flag?: string; mode?: number } | string,
  ): Promise<void> => {
    // fd and flagged/moded writes go straight to memfs — `vfs.writeFile`
    // handles the plain string-path case (watchers + cold replication).
    if (
      typeof path === "number" ||
      (opts !== undefined && typeof opts === "object" && (opts.flag !== undefined || opts.mode !== undefined))
    ) {
      vfs.hot.writeFileSync(
        path as never,
        data as never,
        typeof opts === "object" ? (opts as never) : undefined,
      );
      return;
    }
    await vfs.writeFile(path, data);
  };

  const mkdirImpl = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.mkdir(path, opts);
  };

  const rmImpl = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.rm(path, opts);
  };

  // Realm-safe Dirent construction: memfs Dirent instances lose their
  // prototype methods when they cross the worker RPC boundary (JSON), so
  // dirents are rebuilt locally from each entry's lstat mode bits — `mode`
  // is a plain number and survives serialization.
  const S_IFMT = 0o170000;
  const S_IFREG = 0o100000;
  const S_IFDIR = 0o040000;
  const S_IFLNK = 0o120000;
  const makeDirent = (parentPath: string, name: string) => {
    const full = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    let kind = 0;
    try {
      kind = (Number((vfs.hot.lstatSync(full) as { mode?: number })?.mode) || 0) & S_IFMT;
    } catch {
      // Entry vanished between readdir and lstat — report all-false, like a
      // Dirent for a type we cannot determine.
    }
    return {
      name,
      path: parentPath,
      parentPath,
      isFile: () => kind === S_IFREG,
      isDirectory: () => kind === S_IFDIR,
      isSymbolicLink: () => kind === S_IFLNK,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  };

  const readdirNames = async (path: string, recursive?: boolean): Promise<string[]> => {
    if (recursive) return vfs.hot.readdirSync(path, { recursive: true }) as string[];
    const entries = await vfs.readdir(path);
    return typeof entries[0] === "string"
      ? (entries as string[])
      : (entries as { name: string }[]).map((e) => e.name);
  };

  const readdirImpl = async (
    path: string,
    opts?: { withFileTypes?: boolean; recursive?: boolean },
  ): Promise<unknown> => {
    const names = await readdirNames(path, opts?.recursive);
    if (!opts?.withFileTypes) return names;
    return names.map((name) => {
      // With `recursive`, names contain subpaths ("sub/file") — the Dirent's
      // parent is the entry's own directory, not the readdir root.
      const idx = opts?.recursive ? name.lastIndexOf("/") : -1;
      return idx === -1
        ? makeDirent(path, name)
        : makeDirent(`${path.replace(/\/$/, "")}/${name.slice(0, idx)}`, name.slice(idx + 1));
    });
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

  // Path/data validation is synchronous in Node (a TypeError thrown before
  // any callback or IO is scheduled), so it lives in the exported wrappers,
  // not the promise impls — `assert.throws(() => fs.mkdir(1, cb))` must see
  // a throw, not a rejection.
  const readFile = ((path: string | number, ...rest: any[]) => {
    validatePath(path, "path", true);
    return withCallback(readFileImpl)(
      (typeof path === "number" ? path : pathOf(path as string | Uint8Array | URL)) as never,
      ...rest,
    );
  }) as typeof readFileImpl;
  const writeFile = ((path: string | number, data: unknown, ...rest: any[]) => {
    validatePath(path, "path", true);
    validateWriteData(data);
    return withCallback(writeFileImpl)(
      (typeof path === "number" ? path : pathOf(path as string | Uint8Array | URL)) as never,
      data as never,
      ...rest,
    );
  }) as typeof writeFileImpl;
  const mkdir = ((path: unknown, ...rest: any[]) => {
    validatePath(path);
    return withCallback(mkdirImpl)(pathOf(path as string | Uint8Array | URL), ...rest);
  }) as typeof mkdirImpl;
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
    path: string | number | Uint8Array | URL,
    opts?: { encoding?: string } | string,
  ): string | Uint8Array => {
    validatePath(path, "path", true);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const out = vfs.hot.readFileSync(
      (typeof path === "number" ? path : pathOf(path)) as never,
      encoding as BufferEncoding | undefined,
    ) as string | Uint8Array;
    // memfs returns its own Buffer class; re-wrap so `instanceof Buffer`
    // holds against the shim's Buffer (worker RPC returns a plain Uint8Array).
    return typeof out === "string" ? out : Buffer.from(out);
  };

  const writeFileSync = (
    path: string | number | Uint8Array | URL,
    data: string | Uint8Array,
    opts?: { encoding?: string; flag?: string; mode?: number } | string,
  ): void => {
    validatePath(path, "path", true);
    validateWriteData(data);
    vfs.hot.writeFileSync(
      (typeof path === "number" ? path : pathOf(path)) as never,
      data as never,
      (typeof opts === "object" ? opts : opts ? { encoding: opts } : undefined) as never,
    );
  };

  const mkdirSync = (path: string | Uint8Array | URL, opts?: { recursive?: boolean }) => {
    validatePath(path);
    // memfs returns the first created path under `recursive` (Node ≥13.11
    // parity), undefined otherwise — forward it.
    return vfs.hot.mkdirSync(pathOf(path), opts as never) as string | undefined;
  };

  const rmSync = (path: string, opts?: { recursive?: boolean }): void => {
    vfs.hot.rmSync(path, opts);
  };

  const readdirSync = (path: string, opts?: { withFileTypes?: boolean; recursive?: boolean }) => {
    const names = vfs.hot.readdirSync(path, opts?.recursive ? { recursive: true } : undefined) as
      | string[]
      | { name: string }[];
    const plain =
      typeof names[0] === "string"
        ? (names as string[])
        : (names as { name: string }[]).map((e) => e.name);
    if (!opts?.withFileTypes) return plain;
    return plain.map((name) => {
      const idx = opts?.recursive ? name.lastIndexOf("/") : -1;
      return idx === -1
        ? makeDirent(path, name)
        : makeDirent(`${path.replace(/\/$/, "")}/${name.slice(0, idx)}`, name.slice(idx + 1));
    });
  };

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
  //
  // Inside a process worker `vfs.hot`/`vfs.vol`/`hot.promises` are RPC
  // facades, not the real memfs objects: some members are proxied, some are
  // absent (FileHandle, Dir, streams, stat-watchers — live objects cannot
  // cross the boundary). Construction must therefore feature-detect instead
  // of dereferencing — a member that is absent yields a clear error at call
  // time rather than a TypeError here.
  const hot = vfs.hot as unknown as Record<string, ((...args: any[]) => any) | undefined>;
  const vol = vfs.vol as unknown as
    | Record<string, ((...args: any[]) => any) | undefined>
    | undefined;
  const hotPromises = vfs.hot.promises as unknown as
    | Record<string, ((...args: any[]) => any) | undefined>
    | undefined;

  const unsupported = (name: string): Error =>
    new Error(`fs.${name} is not supported by this VFS backend`);

  /** `dual(hot[name])` that degrades to a clear error when absent. */
  const dualHot = (name: string) => {
    const fn = hot[name];
    if (typeof fn === "function") return dual(fn);
    return (...args: any[]) => {
      const cb =
        typeof args[args.length - 1] === "function" ? (args.pop() as NodeCallback) : undefined;
      const err = unsupported(name);
      if (cb) {
        cb(err);
        return undefined;
      }
      return Promise.reject(err);
    };
  };

  /** `hot[name]` passthrough that throws a clear error when absent. */
  const syncHot = (name: string) => {
    if (typeof hot[name] === "function") return (...args: any[]) => hot[name]!(...args);
    return () => {
      throw unsupported(name);
    };
  };

  /** `hotPromises[name]` passthrough that rejects clearly when absent. */
  const promiseHot = (name: string) => {
    if (typeof hotPromises?.[name] === "function") {
      return (...args: any[]) => hotPromises![name]!(...args);
    }
    return () => Promise.reject(unsupported(`promises.${name}`));
  };

  /** `vol[name]` passthrough that throws a clear error when absent.
   * Receiver is preserved at call time — Volume methods use `this`. */
  const syncVol = (name: string) => {
    if (typeof vol?.[name] === "function") return (...args: any[]) => vol![name]!(...args);
    return () => {
      throw unsupported(name);
    };
  };

  /**
   * A `fs.promises` FileHandle backed by the fd family on `vfs.hot` — all
   * sync ops, so the handle works identically over a real memfs volume and
   * the worker's sync-channel facade (a memfs FileHandle itself cannot
   * cross the boundary). Methods are promise-shaped wrappers around the
   * *Sync ops, matching what memfs' own FileHandle does on the volume.
   */
  class FileHandleShim extends EventEmitter {
    constructor(readonly fd: number) {
      super();
    }

    async close(): Promise<void> {
      vfs.hot.closeSync(this.fd);
      this.emit("close");
    }

    async stat(opts?: { bigint?: boolean }): Promise<FsStat> {
      return vfs.hot.fstatSync(this.fd, opts as never) as unknown as FsStat;
    }

    async truncate(len?: number): Promise<void> {
      vfs.hot.ftruncateSync(this.fd, len);
    }

    async chmod(mode: string | number): Promise<void> {
      vfs.hot.fchmodSync(this.fd, mode as never);
    }

    async chown(uid: number, gid: number): Promise<void> {
      vfs.hot.fchownSync(this.fd, uid, gid);
    }

    async utimes(atime: unknown, mtime: unknown): Promise<void> {
      vfs.hot.futimesSync(this.fd, atime as never, mtime as never);
    }

    async datasync(): Promise<void> {
      vfs.hot.fdatasyncSync(this.fd);
    }

    async sync(): Promise<void> {
      vfs.hot.fsyncSync(this.fd);
    }

    async read(
      buffer: Uint8Array,
      offset?: number,
      length?: number,
      position?: number | null,
    ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
      const bytesRead = vfs.hot.readSync(
        this.fd,
        buffer as never,
        offset ?? 0,
        length ?? buffer.byteLength - (offset ?? 0),
        position ?? null,
      ) as number;
      return { bytesRead, buffer };
    }

    async readFile(opts?: { encoding?: string } | string): Promise<string | Uint8Array> {
      const encoding = typeof opts === "string" ? opts : opts?.encoding;
      const out = vfs.hot.readFileSync(this.fd, encoding as BufferEncoding | undefined) as
        | string
        | Uint8Array;
      return typeof out === "string" ? out : Buffer.from(out);
    }

    async write(
      buffer: Uint8Array | string,
      offset?: number,
      length?: number,
      position?: number | null,
    ): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
      const bytesWritten = vfs.hot.writeSync(
        this.fd,
        buffer as never,
        offset ?? 0,
        length as never,
        position ?? null,
      ) as number;
      return { bytesWritten, buffer };
    }

    async writeFile(
      data: string | Uint8Array,
      opts?: { encoding?: string } | string,
    ): Promise<void> {
      vfs.hot.writeFileSync(
        this.fd,
        data as never,
        (typeof opts === "object" ? opts : opts ? { encoding: opts } : undefined) as never,
      );
    }

    async appendFile(
      data: string | Uint8Array,
      opts?: { encoding?: string } | string,
    ): Promise<void> {
      vfs.hot.appendFileSync(
        this.fd,
        data as never,
        (typeof opts === "object" ? opts : opts ? { encoding: opts } : undefined) as never,
      );
    }

    createReadStream(): unknown {
      throw unsupported("promises.open#createReadStream");
    }

    createWriteStream(): unknown {
      throw unsupported("promises.open#createWriteStream");
    }

    async [Symbol.asyncDispose](): Promise<void> {
      await this.close();
    }

    get [Symbol.toStringTag](): string {
      return "FileHandle";
    }
  }

  /**
   * `fs.promises.open` — needs `hot.openSync` (present on a real VfsBus and
   * the worker facade). Rejects clearly where the backend lacks the fd
   * family.
   */
  const promisesOpen =
    typeof vfs.hot.openSync === "function"
      ? async (
          path: string | Uint8Array | URL,
          flags?: string | number,
          mode?: string | number,
        ): Promise<FileHandleShim> => {
          validatePath(path, "path", true);
          if (typeof path === "number") return new FileHandleShim(path);
          return new FileHandleShim(vfs.hot.openSync(pathOf(path), flags as never, mode as never));
        }
      : () => Promise.reject(unsupported("promises.open"));

  const realpathNativeFn = (hot.realpath as { native?: unknown } | undefined)?.native;
  const realpath = Object.assign(
    dualHot("realpath"),
    typeof realpathNativeFn === "function"
      ? { native: dual(realpathNativeFn as (...args: any[]) => any) }
      : {},
  );
  const realpathSyncNativeFn = (hot.realpathSync as { native?: unknown } | undefined)?.native;
  const realpathSync = Object.assign(
    (path: string, opts?: unknown) => vfs.hot.realpathSync(path, opts as never) as string,
    typeof realpathSyncNativeFn === "function"
      ? {
          native: (path: string, opts?: unknown) =>
            (realpathSyncNativeFn as (...args: any[]) => any)(path, opts) as string,
        }
      : {},
  );

  const promises = {
    // Two-layer-aware subset (kept: reads reach OPFS-cold paths on
    // eviction miss; writes go through the bus so watchers/middleware fire).
    readFile: (path: unknown, opts?: { encoding?: string } | string) =>
      path instanceof FileHandleShim
        ? path.readFile(opts)
        : readFileImpl(
            typeof path === "number" ? path : pathOf(path as string | Uint8Array | URL),
            opts,
          ),
    writeFile: async (path: unknown, data: unknown, opts?: unknown) => {
      // The promises surface rejects rather than throwing — validate inside.
      validatePath(path, "path", true);
      validateWriteData(data);
      if (path instanceof FileHandleShim) {
        return path.writeFile(data as string | Uint8Array, opts as never);
      }
      return writeFileImpl(pathOf(path as string | Uint8Array | URL), data as never, opts as never);
    },
    mkdir: mkdirImpl,
    rm: rmImpl,
    readdir: readdirImpl,
    exists: existsImpl,
    stat: statImpl,
    symlink: symlinkImpl,
    readlink: readlinkImpl,
    lstat: lstatImpl,
    // memfs FsPromises breadth — includes `open` returning a real FileHandle
    // (on a real VfsBus; on a worker facade `open`/`opendir`/`watch`/`glob`
    // reject clearly — their results cannot cross the boundary).
    access: promiseHot("access"),
    appendFile: promiseHot("appendFile"),
    chmod: promiseHot("chmod"),
    chown: promiseHot("chown"),
    copyFile: promiseHot("copyFile"),
    cp: promiseHot("cp"),
    lchmod: promiseHot("lchmod"),
    lchown: promiseHot("lchown"),
    link: promiseHot("link"),
    lutimes: promiseHot("lutimes"),
    mkdtemp: promiseHot("mkdtemp"),
    // A FileHandle built on the fd family — works on a real VfsBus AND the
    // worker sync-channel facade (a memfs FileHandle can't cross the wire).
    open: promisesOpen,
    opendir: promiseHot("opendir"),
    realpath: promiseHot("realpath"),
    rename: promiseHot("rename"),
    rmdir: promiseHot("rmdir"),
    statfs: promiseHot("statfs"),
    truncate: promiseHot("truncate"),
    unlink: promiseHot("unlink"),
    utimes: promiseHot("utimes"),
    watch: promiseHot("watch"),
    glob: promiseHot("glob"),
    constants: vfs.hot.constants,
    FileHandle: FileHandleShim,
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
    // Callback/promise dual surface backed by memfs directly (or by the
    // worker RPC facade, which presents the same callback contract).
    access: dualHot("access"),
    accessSync: (path: string, mode?: number) => vfs.hot.accessSync(path, mode),
    appendFile: dualHot("appendFile"),
    appendFileSync: (path: string, data: string | Uint8Array, opts?: unknown) =>
      vfs.hot.appendFileSync(path, data, opts as never),
    chmod: dualHot("chmod"),
    chmodSync: (path: string, mode: string | number) => vfs.hot.chmodSync(path, mode as never),
    chown: dualHot("chown"),
    chownSync: (path: string, uid: number, gid: number) => vfs.hot.chownSync(path, uid, gid),
    close: dualHot("close"),
    closeSync: (fd: number) => vfs.hot.closeSync(fd),
    copyFile: dualHot("copyFile"),
    copyFileSync: (src: string, dest: string, mode?: number) =>
      vfs.hot.copyFileSync(src, dest, mode),
    cp: dualHot("cp"),
    cpSync: (src: string, dest: string, opts?: unknown) => syncVol("cpSync")(src, dest, opts),
    fchmod: dualHot("fchmod"),
    fchmodSync: (fd: number, mode: string | number) => vfs.hot.fchmodSync(fd, mode as never),
    fchown: dualHot("fchown"),
    fchownSync: (fd: number, uid: number, gid: number) => vfs.hot.fchownSync(fd, uid, gid),
    fdatasync: dualHot("fdatasync"),
    fdatasyncSync: (fd: number) => vfs.hot.fdatasyncSync(fd),
    fstat: dualHot("fstat"),
    fstatSync: (fd: number) => vfs.hot.fstatSync(fd) as unknown as FsStat,
    fsync: dualHot("fsync"),
    fsyncSync: (fd: number) => vfs.hot.fsyncSync(fd),
    ftruncate: dualHot("ftruncate"),
    ftruncateSync: (fd: number, len?: number) => vfs.hot.ftruncateSync(fd, len),
    futimes: dualHot("futimes"),
    futimesSync: (fd: number, atime: unknown, mtime: unknown) =>
      vfs.hot.futimesSync(fd, atime as never, mtime as never),
    lchmod: dualHot("lchmod"),
    lchmodSync: (path: string, mode: string | number) => vfs.hot.lchmodSync(path, mode as never),
    lchown: dualHot("lchown"),
    lchownSync: (path: string, uid: number, gid: number) => vfs.hot.lchownSync(path, uid, gid),
    link: dualHot("link"),
    linkSync: (existingPath: string, newPath: string) => vfs.hot.linkSync(existingPath, newPath),
    lutimes: dualHot("lutimes"),
    lutimesSync: (path: string, atime: unknown, mtime: unknown) =>
      vfs.hot.lutimesSync(path, atime as never, mtime as never),
    mkdtemp: dualHot("mkdtemp"),
    mkdtempSync: (prefix: string, opts?: unknown) =>
      vfs.hot.mkdtempSync(prefix, opts as never) as string,
    open: dualHot("open"),
    openSync: (path: string, flags?: string | number, mode?: string | number) =>
      vfs.hot.openSync(path, flags as never, mode as never),
    opendir: dualHot("opendir"),
    opendirSync: (path: string, opts?: unknown): FsDirShim =>
      syncHot("opendirSync")(path, opts) as unknown as FsDirShim,
    read: dualHot("read"),
    readSync: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => vfs.hot.readSync(fd, buffer as never, offset, length, position),
    readv: dualHot("readv"),
    readvSync: (fd: number, buffers: Uint8Array[], position?: number | null) =>
      vfs.hot.readvSync(fd, buffers as never[], position),
    realpath,
    realpathSync,
    rename: dualHot("rename"),
    renameSync: (oldPath: string, newPath: string) => vfs.hot.renameSync(oldPath, newPath),
    rmdir: dualHot("rmdir"),
    rmdirSync: (path: string, opts?: unknown) => vfs.hot.rmdirSync(path, opts as never),
    statfs: dualHot("statfs"),
    statfsSync: (path: string, opts?: unknown) => syncVol("statfsSync")(path, opts),
    truncate: dualHot("truncate"),
    truncateSync: (path: string, len?: number) => vfs.hot.truncateSync(path, len),
    unlink: dualHot("unlink"),
    unlinkSync: (path: string) => vfs.hot.unlinkSync(path),
    utimes: dualHot("utimes"),
    utimesSync: (path: string, atime: unknown, mtime: unknown) =>
      vfs.hot.utimesSync(path, atime as never, mtime as never),
    write: dualHot("write"),
    writeSync: (fd: number, buffer: Uint8Array | string, ...rest: any[]) =>
      vfs.hot.writeSync(fd, buffer as never, ...(rest as [number, number, number | null])),
    writev: dualHot("writev"),
    writevSync: (fd: number, buffers: Uint8Array[], position?: number | null) =>
      vfs.hot.writevSync(fd, buffers as never[], position),
    // Stat polling watchers (Node semantics: listener gets (curr, prev)
    // Stats). Stat watchers are main-realm objects — absent on a worker
    // facade, so this degrades to a clear error there.
    watchFile:
      typeof hot.watchFile === "function"
        ? (path: string, ...args: any[]) => (hot.watchFile as (...a: any[]) => any)(path, ...args)
        : () => {
            throw unsupported("watchFile");
          },
    unwatchFile: (path: string, listener?: (...args: any[]) => void) => {
      if (typeof hot.unwatchFile === "function") hot.unwatchFile(path, listener);
    },
    StatWatcher: (vfs.hot as unknown as { StatWatcher?: unknown }).StatWatcher,
    // Streams backed by memfs' own stream classes (fs-node-builtins — no
    // node:stream dependency, so they work in the browser realm). Live
    // streams cannot cross the worker boundary — absent on the facade.
    createReadStream: (path: string, opts?: unknown): FsStreamShim =>
      syncHot("createReadStream")(path, opts) as unknown as FsStreamShim,
    createWriteStream: (path: string, opts?: unknown): FsStreamShim =>
      syncHot("createWriteStream")(path, opts) as unknown as FsStreamShim,
    ReadStream: (vfs.hot as unknown as { ReadStream?: unknown }).ReadStream,
    WriteStream: (vfs.hot as unknown as { WriteStream?: unknown }).WriteStream,
    FSWatcher: (vfs.hot as unknown as { FSWatcher?: unknown }).FSWatcher,
    Stats: (vfs.hot as unknown as { Stats?: unknown }).Stats,
    Dirent: (vfs.hot as unknown as { Dirent?: unknown }).Dirent,
    // Full Node constants set (O_*, S_*, COPYFILE_*, access modes) — memfs
    // ships the same table as real fs.constants; the worker facade fetches
    // it over the wire. Optional-chained so construction still survives a
    // VFS backend without it.
    constants: vfs.hot.constants,
    F_OK: (vfs.hot as unknown as { constants?: { F_OK?: number } }).constants?.F_OK,
    R_OK: (vfs.hot as unknown as { constants?: { R_OK?: number } }).constants?.R_OK,
    W_OK: (vfs.hot as unknown as { constants?: { W_OK?: number } }).constants?.W_OK,
    X_OK: (vfs.hot as unknown as { constants?: { X_OK?: number } }).constants?.X_OK,
    glob: dualHot("glob"),
    promises,
  };
};

export type FsShim = ReturnType<typeof createFsShim>;
