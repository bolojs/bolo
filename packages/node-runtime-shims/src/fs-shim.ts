import type { VfsBus } from "@bolojs/vfs-bus";
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

export const createFsShim = (vfs: VfsBus) => {
  const readFile = async (
    path: string,
    opts?: { encoding?: string } | string,
  ): Promise<string | Uint8Array> => {
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    const result = await vfs.readFile(path);
    if (encoding === "utf8" || encoding === "utf-8") return String(result);
    return result;
  };

  const writeFile = async (
    path: string,
    data: string | Uint8Array,
    _opts?: { encoding?: string },
  ): Promise<void> => {
    await vfs.writeFile(path, data);
  };

  const mkdir = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.mkdir(path, opts);
  };

  const rm = async (path: string, opts?: { recursive?: boolean }): Promise<void> => {
    await vfs.rm(path, opts);
  };

  const readdir = async (path: string): Promise<string[]> => {
    const entries = await vfs.readdir(path);
    return typeof entries[0] === "string"
      ? (entries as string[])
      : (entries as { name: string }[]).map((e) => e.name);
  };

  const exists = async (path: string): Promise<boolean> => {
    return await vfs.exists(path);
  };

  const stat = async (path: string): Promise<FsStat> => {
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

  const symlink = async (target: string, path: string, _type?: string): Promise<void> => {
    vfs.hot.symlinkSync(target, path);
  };

  const readlink = async (path: string): Promise<string> => vfs.hot.readlinkSync(path) as string;

  const lstat = async (path: string): Promise<FsStat> =>
    vfs.hot.lstatSync(path) as unknown as FsStat;

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
    promises: { readFile, writeFile, mkdir, rm, readdir, exists, stat, symlink, readlink, lstat },
  };
};

export type FsShim = ReturnType<typeof createFsShim>;
