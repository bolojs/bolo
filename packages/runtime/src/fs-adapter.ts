import type { VfsBus, DirEnt as VfsDirEnt } from '@browser-containers/vfs-bus';
import type { FileSystemAPI, DirEnt } from './container-types.js';

export function createFileSystem(vfs: VfsBus): FileSystemAPI {
  async function readFile(path: string): Promise<string> {
    const result = await vfs.readFile(path);
    if (result instanceof Uint8Array) {
      return new TextDecoder().decode(result);
    }
    return result;
  }

  async function writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await vfs.writeFile(path, data);
  }

  async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await vfs.mkdir(path, options);
  }

  async function rm(path: string): Promise<void> {
    await vfs.rm(path, { recursive: true });
  }

  async function exists(path: string): Promise<boolean> {
    return vfs.exists(path);
  }

  async function readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirEnt[]> {
    const entries = await vfs.readdir(path, options);
    if (options?.withFileTypes) {
      return (entries as VfsDirEnt[]).map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        isDirectory: () => e.isDirectory(),
      }));
    }
    return entries as string[];
  }

  async function rename(oldPath: string, newPath: string): Promise<void> {
    await vfs.rename(oldPath, newPath);
  }

  function watch(
    path: string,
    options?: { recursive?: boolean },
    listener?: (event: 'rename' | 'change', filename: string) => void
  ) {
    const glob = path.includes('.') ? path : `${path}/*`;

    const handler = (filePath: string, event: 'add' | 'change' | 'unlink') => {
      if (!listener) return;
      const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
      if (event === 'add' || event === 'unlink') {
        listener('rename', filename);
      } else if (event === 'change') {
        listener('change', filename);
      }
    };

    const watcher = vfs.watch(glob, handler);
    return { close: () => watcher.close() };
  }

  return { readFile, writeFile, mkdir, rm, exists, readdir, rename, watch };
}
