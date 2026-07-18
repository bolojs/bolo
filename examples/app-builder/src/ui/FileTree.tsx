import { useEffect, useMemo, useRef, useState } from "react";
import LazyTreeView, {
  type BranchProps,
  type BaseNodeProps,
  type LazyTreeViewHandle,
} from "lazy-tree-view";
import "lazy-tree-view/styles.css";
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
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { buildFileTree } from "@/lib/tree";

interface Props {
  files: string[];
  activePath: string | null;
  onSelect(path: string): void;
}

const EXT_ICON: Record<string, { icon: typeof File; className: string }> = {
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

function Branch({ name, depth, isOpen, onToggleOpen }: BranchProps) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px] hover:bg-accent"
      style={{ paddingLeft: 6 + depth * INDENT_PX }}
      onClick={onToggleOpen}
      role="button"
      tabIndex={-1}
    >
      <ChevronRight
        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
        aria-hidden="true"
      />
      {isOpen ? (
        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="truncate">{name}</span>
    </div>
  );
}

function makeItemRenderer(activePath: string | null, onSelect: (path: string) => void) {
  return function Item({ id, name, depth }: BaseNodeProps) {
    const { icon: Icon, className } = fileIcon(name);
    const active = id === activePath;
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px]",
          active ? "bg-accent text-accent-foreground" : "hover:bg-accent",
        )}
        style={{ paddingLeft: 6 + (depth + 1) * INDENT_PX }}
        onClick={() => onSelect(id)}
        role="button"
        tabIndex={-1}
      >
        <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden="true" />
        <span className="truncate font-mono text-[12px]">{name}</span>
      </div>
    );
  };
}

export default function FileTree({ files, activePath, onSelect }: Props) {
  const treeRef = useRef<LazyTreeViewHandle>(null);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return files;
    const q = filter.trim().toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q));
  }, [files, filter]);

  const tree = useMemo(() => buildFileTree(filtered), [filtered]);
  const Item = useMemo(() => makeItemRenderer(activePath, onSelect), [activePath, onSelect]);

  useEffect(() => {
    treeRef.current?.setTree(tree);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border">
      <div className="relative shrink-0 border-b border-border p-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          className="h-7 pl-7 text-xs"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          <LazyTreeView
            ref={treeRef}
            initialTree={tree}
            loadChildren={async () => []}
            allowDragAndDrop={false}
            branch={Branch}
            item={Item}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
