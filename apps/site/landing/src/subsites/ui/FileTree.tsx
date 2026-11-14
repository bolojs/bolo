/** @jsxImportSource solid-js */
import { createSignal, For, JSX, onCleanup, onMount } from "solid-js";
import type { VfsBus } from "@bolojs/fs";

interface Props {
  vfs: VfsBus;
  /** Directory to show as the tree root, e.g. the container workdir. */
  root: string;
  activePath: string | null;
  onSelect(path: string): void;
  /** Extra paths to hide, matched by prefix. Defaults to hiding nothing. */
  exclude?: (path: string) => boolean;
}

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

/**
 * File tree over a VfsBus directory: initial recursive read, then kept in
 * sync by the VFS watch stream. Directories expand/collapse locally.
 */
export default function FileTree(props: Props) {
  const [tree, setTree] = createSignal<Node[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([props.root]));

  const readTree = async (dir: string): Promise<Node[]> => {
    const exclude = props.exclude;
    let entries;
    try {
      entries = await props.vfs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: Node[] = [];
    for (const entry of entries as { name: string; isDirectory: () => boolean }[]) {
      const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
      if (exclude?.(path)) continue;
      const isDir = entry.isDirectory();
      nodes.push({
        name: entry.name,
        path,
        dir: isDir,
        children: isDir ? await readTree(path) : [],
      });
    }
    return nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  };

  const refresh = async () => {
    setTree(await readTree(props.root));
  };

  onMount(() => {
    void refresh();
    const unwatch = props.vfs.watch("**", () => {
      void refresh();
    });
    onCleanup(() => unwatch.close());
  });

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: Node[], depth: number): JSX.Element => (
    <For each={nodes}>
      {(node) => (
        <>
          <button
            type="button"
            data-file={node.path}
            style={{ "padding-left": `${8 + depth * 14}px` }}
            class={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[12.5px] ${
              node.path === props.activePath ? "bg-[color-mix(in_srgb,var(--fg)_8%,transparent)] text-fg" : "text-muted hover:text-fg"
            }`}
            onClick={() => (node.dir ? toggle(node.path) : props.onSelect(node.path))}
          >
            <span class="w-3 shrink-0 text-[10px]">
              {node.dir ? (expanded().has(node.path) ? "▾" : "▸") : ""}
            </span>
            <span class="truncate">{node.name}</span>
          </button>
          {node.dir && expanded().has(node.path) && renderNodes(node.children, depth + 1)}
        </>
      )}
    </For>
  );

  return (
    <nav data-panel="file-tree" aria-label="File tree" class="h-full min-h-0 overflow-auto py-1">
      {renderNodes(tree(), 0)}
    </nav>
  );
}
