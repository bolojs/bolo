import type { VfsBus } from '@browser-containers/vfs-bus';

const SYNC_ERR = 'not supported in browser runtime';

export const createFsShim = (vfs: VfsBus) => {
  const readFile = async (path: string, opts?: { encoding?: string } | string): Promise<string | Uint8Array> => {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    const result = await vfs.readFile(path);
    if (encoding === 'utf8' || encoding === 'utf-8') return String(result);
    return result;
  };

  const writeFile = async (path: string, data: string | Uint8Array, _opts?: { encoding?: string }): Promise<void> => {
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
    return typeof entries[0] === 'string' ? (entries as string[]) : (entries as { name: string }[]).map((e) => e.name);
  };

  const exists = async (path: string): Promise<boolean> => {
    return await vfs.exists(path);
  };

  const stat = async (path: string): Promise<{
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
  }> => {
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

  const watch = (path: string, optsOrHandler?: { persistent?: boolean } | ((...args: any[]) => void), handler?: (...args: any[]) => void) => {
    const h = typeof optsOrHandler === 'function' ? optsOrHandler : handler;
    const w = vfs.watch(path, (filePath, event) => {
      if (h) h(event, filePath);
    });
    return {
      close: () => w.close(),
      on: (event: string, _cb: (...args: any[]) => void) => {
        void event;
        return { close: () => w.close() } as unknown as ReturnType<typeof watch>;
      },
    };
  };

  return {
    readFile,
    readFileSync: (_path?: string, _opts?: unknown) => { throw new Error(`readFileSync ${SYNC_ERR}`); },
    writeFile,
    writeFileSync: (_path?: string, _data?: unknown, _opts?: unknown) => { throw new Error(`writeFileSync ${SYNC_ERR}`); },
    mkdir,
    mkdirSync: (_path?: string, _opts?: unknown) => { throw new Error(`mkdirSync ${SYNC_ERR}`); },
    rm,
    rmSync: (_path?: string, _opts?: unknown) => { throw new Error(`rmSync ${SYNC_ERR}`); },
    readdir,
    readdirSync: (_path?: string) => { throw new Error(`readdirSync ${SYNC_ERR}`); },
    exists,
    existsSync: (_path?: string) => { throw new Error(`existsSync ${SYNC_ERR}`); },
    stat,
    statSync: (_path?: string) => { throw new Error(`statSync ${SYNC_ERR}`); },
    watch,
    promises: { readFile, writeFile, mkdir, rm, readdir, exists, stat },
  };
};

export type FsShim = ReturnType<typeof createFsShim>;
