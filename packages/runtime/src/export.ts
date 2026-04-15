import type { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemTree } from './container-types.js';

export interface ExportAPI {
  exportTree(basePath?: string): Promise<FileSystemTree>;
}

export function createExport(vfs: VfsBus): ExportAPI {
  async function exportTree(path = ''): Promise<FileSystemTree> {
    const tree: FileSystemTree = {};
    const entries = await vfs.readdir(path || '/', { withFileTypes: true }) as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    for (const entry of entries) {
      const entryPath = path ? `${path}/${entry.name}` : `/${entry.name}`;
      if (entry.isDirectory()) {
        tree[entry.name] = { directory: await exportTree(entryPath) };
      } else if (entry.isFile()) {
        const content = await vfs.readFile(entryPath);
        tree[entry.name] = { file: { contents: content as string | Uint8Array } };
      }
    }
    return tree;
  }

  return { exportTree };
}
