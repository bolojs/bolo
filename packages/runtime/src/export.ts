import type { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemTree, FileNode, DirectoryNode } from './container-types';

const decoder = new TextDecoder();

const toFileContents = (data: string | Uint8Array): string =>
  data instanceof Uint8Array ? decoder.decode(data) : data;

const buildTree = async (vfs: VfsBus, dirPath: string): Promise<FileSystemTree> => {
  const entries = vfs.hot.readdirSync(dirPath, { withFileTypes: true });

  const tree: FileSystemTree = {};

  for (const entry of entries) {
    const fullPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;

    if (entry.isFile()) {
      const data = await vfs.readFile(fullPath);
      tree[entry.name] = { file: { contents: toFileContents(data) } } satisfies FileNode;
    } else if (entry.isDirectory()) {
      tree[entry.name] = { directory: await buildTree(vfs, fullPath) } satisfies DirectoryNode;
    }
  }

  return tree;
};

export const createExport = (vfs: VfsBus) => {
  const exportTree = async (): Promise<FileSystemTree> => {
    const rootEntries = vfs.hot.readdirSync('/', { withFileTypes: true });
    if (rootEntries.length === 0) return {};

    return buildTree(vfs, '/');
  };

  return exportTree;
};
