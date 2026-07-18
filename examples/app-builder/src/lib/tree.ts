import type { BranchNode, TreeNode } from "lazy-tree-view";

interface DirEntry {
  dirs: Map<string, DirEntry>;
  files: string[];
}

const makeDirEntry = (): DirEntry => ({ dirs: new Map(), files: [] });

function toNodes(entry: DirEntry, prefix: string): TreeNode[] {
  const dirNodes: BranchNode[] = [...entry.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => {
      const id = prefix ? `${prefix}/${name}` : name;
      return { id, name, isOpen: true, children: toNodes(child, id) };
    });
  const fileNodes: TreeNode[] = entry.files
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: prefix ? `${prefix}/${name}` : name, name }));
  return [...dirNodes, ...fileNodes];
}

/** Folds a flat relative-path list (as produced by `listFilesRecursive`) into
 * nested `TreeNode[]`, folders sorted before files, both alphabetical. */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root = makeDirEntry();

  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      let next = node.dirs.get(seg);
      if (!next) {
        next = makeDirEntry();
        node.dirs.set(seg, next);
      }
      node = next;
    }
    const fileName = segments[segments.length - 1];
    if (fileName) node.files.push(fileName);
  }

  return toNodes(root, "");
}
