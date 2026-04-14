import type { VfsBus } from '@browser-containers/vfs-bus';
import type { FileSystemTree } from './container-types';

const isFileNode = (node: FileSystemTree[string]): node is { file: { contents: string | Uint8Array | ReadableStream<Uint8Array> } } =>
  'file' in node;

const isDirectoryNode = (node: FileSystemTree[string]): node is { directory: FileSystemTree } =>
  'directory' in node;

export const createMount = (vfs: VfsBus) => {
  const mountTree = async (tree: FileSystemTree, basePath = ''): Promise<void> => {
    const entries = Object.entries(tree);

    await Promise.all(
      entries.map(async ([name, node]) => {
        const fullPath = basePath === '' ? `/${name}` : `${basePath}/${name}`;

        if (isFileNode(node)) {
          const contents = node.file.contents;
          if (contents instanceof ReadableStream) {
            // Skip ReadableStream — not in v1.0 scope for mount
            return;
          }
          await vfs.writeFile(fullPath, contents);
        } else if (isDirectoryNode(node)) {
          await vfs.mkdir(fullPath, { recursive: true });
          await mountTree(node.directory, fullPath);
        }
      }),
    );
  };

  return mountTree;
};
