import { CircleDot, FilePen, FilePlus, FileX, ListTree, Loader2, SquareTerminal, type LucideIcon } from "lucide-solid";
import { cn } from "../lib/utils";
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

export function ToolReceiptView(props: { receipt: ToolReceipt }) {
  const ToolIcon = TOOL_ICON[props.receipt.toolName] ?? CircleDot;
  const StatusIcon = props.receipt.status === "running" ? Loader2 : CircleDot;
  return (
    <div class="flex items-baseline gap-1.5 py-0.5 font-mono text-xs">
      <StatusIcon
        class={cn(
          "size-3 shrink-0 self-center",
          statusClass[props.receipt.status],
          props.receipt.status === "running" && "animate-spin",
        )}
        aria-hidden="true"
      />
      <ToolIcon class="size-3 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
      <span class="font-semibold">{props.receipt.toolName}</span>
      <span class="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
        {summarizeInput(props.receipt.input)}
      </span>
    </div>
  );
}
