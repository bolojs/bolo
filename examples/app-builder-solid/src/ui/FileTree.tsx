import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import {
  Braces,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Search,
} from "lucide-solid";
import type { TreeNode } from "lazy-tree-view";
import { cn } from "@/lib/utils";
import { buildFileTree } from "@/lib/tree";

interface Props {
  files: string[];
  activePath: string | null;
  onSelect(path: string): void;
}

const EXT_ICON: Record<string, { icon: Component<{ class?: string }>; className: string }> = {
  ts: { icon: FileCode, className: "text-blue-500" },
  tsx: { icon: FileCode, className: "text-blue-500" },
  js: { icon: FileCode, className: "text-yellow-500" },
  jsx: { icon: FileCode, className: "text-yellow-500" },
  json: { icon: FileJson, className: "text-amber-500" },
  css: { icon: Braces, className: "text-sky-500" },
  html: { icon: FileCode, className: "text-orange-500" },
  md: { icon: FileText, className: "text-muted-foreground" },
};

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_ICON[ext] ?? { icon: File, className: "text-muted-foreground" };
}

const INDENT_PX = 14;

function isBranch(node: TreeNode): node is Extract<TreeNode, { children: unknown }> {
  return "children" in node;
}

function TreeNodeView(props: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelect(path: string): void;
}) {
  const [open, setOpen] = createSignal(true);
  const branch = () => (isBranch(props.node) ? props.node : null);
  return (
    <Show when={branch()} fallback={<FileItem node={props.node} depth={props.depth} activePath={props.activePath} onSelect={props.onSelect} />}>
      {(b) => (
        <div>
          <div
            class="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px] hover:bg-accent cursor-pointer"
            style={{ "padding-left": `${6 + props.depth * INDENT_PX}px` }}
            onClick={() => setOpen(!open())}
            role="button"
            tabIndex={-1}
          >
            <ChevronRight
              class={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open() && "rotate-90")}
              aria-hidden="true"
            />
            <Show
              when={open()}
              fallback={<Folder class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            >
              <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Show>
            <span class="truncate">{b().name}</span>
          </div>
          <Show when={open()}>
            <For each={b().children}>
              {(child) => (
                <TreeNodeView
                  node={child}
                  depth={props.depth + 1}
                  activePath={props.activePath}
                  onSelect={props.onSelect}
                />
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );
}

function FileItem(props: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelect(path: string): void;
}) {
  const { icon: Icon, className } = fileIcon(props.node.name);
  const active = () => props.node.id === props.activePath;
  return (
    <div
      class={cn(
        "flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px] cursor-pointer",
        active() ? "bg-accent text-accent-foreground" : "hover:bg-accent",
      )}
      style={{ "padding-left": `${6 + (props.depth + 1) * INDENT_PX}px` }}
      onClick={() => props.onSelect(props.node.id)}
      role="button"
      tabIndex={-1}
    >
      <Icon class={cn("size-3.5 shrink-0", className)} aria-hidden="true" />
      <span class="truncate font-mono text-[12px]">{props.node.name}</span>
    </div>
  );
}

export default function FileTree(props: Props) {
  const [filter, setFilter] = createSignal("");
  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return props.files;
    return props.files.filter((f) => f.toLowerCase().includes(q));
  });
  const tree = createMemo(() => buildFileTree(filtered()));

  return (
    <div class="flex h-full min-h-0 flex-col border-r border-border">
      <div class="relative shrink-0 border-b border-border p-1.5">
        <Search class="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter files…"
          class="h-7 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="p-1">
          <For each={tree()}>
            {(node) => (
              <TreeNodeView node={node} depth={0} activePath={props.activePath} onSelect={props.onSelect} />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
