import type { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemAPI, DirEnt } from './container-types.js';

const createDirEnt = (name: string, isFile: boolean): DirEnt => ({
  name,
  isFile: () => isFile,
  isDirectory: () => !isFile,
});

const withErrorCode = (error: Error, code: 'ENOENT' | 'EEXIST'): Error & { code: string } => {
  const err = error as Error & { code: string | undefined };
  err.code = code;
  return err as Error & { code: string };
};

const isFile = async (vfs: VfsBus, path: string): Promise<boolean> => {
  try {
    await vfs.readFile(path);
    return true;
  } catch {
    return false;
  }
};

const moveDirectory = async (vfs: VfsBus, srcPath: string, destPath: string): Promise<void> => {
  const entries = await vfs.readdir(srcPath);

  for (const entry of entries) {
    const srcEntry = srcPath === '/' ? `/${entry}` : `${srcPath}/${entry}`;
    const destEntry = destPath === '/' ? `/${entry}` : `${destPath}/${entry}`;

    const entryIsFile = await isFile(vfs, srcEntry);

    if (entryIsFile) {
      const content = await vfs.readFile(srcEntry);
      await vfs.writeFile(destEntry, content);
      await vfs.rm(srcEntry, { recursive: true });
    } else {
      await vfs.mkdir(destEntry, { recursive: true });
      await moveDirectory(vfs, srcEntry, destEntry);
      await vfs.rm(srcEntry, { recursive: true });
    }
  }
};

export const createFileSystem = (vfs: VfsBus): FileSystemAPI => {
  const readFile = async (path: string): Promise<string> => {
    try {
      const result = await vfs.readFile(path);
      return typeof result === 'string' ? result : new TextDecoder().decode(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT:')) {
        throw withErrorCode(error, 'ENOENT');
      }
      throw error;
    }
  };

  const writeFile = async (path: string, data: string | Uint8Array): Promise<void> => {
    await vfs.writeFile(path, data);
  };

  const mkdir = async (path: string, options?: { recursive?: boolean }): Promise<void> => {
    await vfs.mkdir(path, options);
  };

  const rm = async (path: string): Promise<void> => {
    try {
      await vfs.rm(path, { recursive: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw error;
      }
      throw error;
    }
  };

  const readdir = async (
    path: string,
    options?: { withFileTypes?: boolean }
  ): Promise<string[] | DirEnt[]> => {
    try {
      const entries = await vfs.readdir(path);

      if (options?.withFileTypes) {
        const dirEnts: DirEnt[] = [];

        for (const name of entries) {
          const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;
          const entryIsFile = await isFile(vfs, fullPath);
          dirEnts.push(createDirEnt(name, entryIsFile));
        }

        return dirEnts;
      }

      return entries;
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT:')) {
        throw withErrorCode(error, 'ENOENT');
      }
      throw error;
    }
  };

  const rename = async (oldPath: string, newPath: string): Promise<void> => {
    try {
      const srcExists = await vfs.exists(oldPath);
      if (!srcExists) {
        const error = new Error(`ENOENT: ${oldPath}`);
        throw withErrorCode(error, 'ENOENT');
      }

      const destExists = await vfs.exists(newPath);
      if (destExists) {
        const error = new Error(`EEXIST: ${newPath}`);
        throw withErrorCode(error, 'EEXIST');
      }

      const srcIsFile = await isFile(vfs, oldPath);

      if (srcIsFile) {
        const content = await vfs.readFile(oldPath);
        await vfs.writeFile(newPath, content);
        await vfs.rm(oldPath, { recursive: true });
      } else {
        await vfs.mkdir(newPath, { recursive: true });
        await moveDirectory(vfs, oldPath, newPath);
        await vfs.rm(oldPath, { recursive: true });
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw error;
      }
      throw error;
    }
  };

  return {
    readFile,
    writeFile,
    mkdir,
    rm,
    readdir,
    rename,
  };
};
