import { CircleDot, FilePen, FilePlus, FileX, ListTree, Loader2, SquareTerminal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolReceipt } from "../ai/useBuilderChat";

const statusClass: Record<ToolReceipt["status"], string> = {
  running: "text-status-pending",
  done: "text-status-ok",
  error: "text-status-error",
};

const TOOL_ICON: Record<string, LucideIcon> = {
  writeFile: FilePlus,
  readFile: FilePen,
  deleteFile: FileX,
  listFiles: ListTree,
  runCommand: SquareTerminal,
};

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object" && "path" in input) return String((input as { path: unknown }).path);
  if (input && typeof input === "object" && "command" in input) {
    const { command, args } = input as { command: string; args?: string[] };
    return [command, ...(args ?? [])].join(" ");
  }
  return "";
}

export default function ToolReceiptView({ receipt }: { receipt: ToolReceipt }) {
  const ToolIcon = TOOL_ICON[receipt.toolName] ?? CircleDot;
  const StatusIcon = receipt.status === "running" ? Loader2 : CircleDot;
  return (
    <div className="flex items-baseline gap-1.5 py-0.5 font-mono text-xs">
      <StatusIcon
        className={cn("size-3 shrink-0 self-center", statusClass[receipt.status], receipt.status === "running" && "animate-spin")}
        aria-hidden="true"
      />
      <ToolIcon className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
      <span className="font-semibold">{receipt.toolName}</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
        {summarizeInput(receipt.input)}
      </span>
    </div>
  );
}
