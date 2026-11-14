/** @jsxImportSource solid-js */
import type { ToolReceipt } from "../ai/chat";

const statusDot: Record<ToolReceipt["status"], string> = {
  running: "animate-pulse bg-[var(--accent)]",
  done: "bg-[var(--success)]",
  error: "bg-[var(--danger)]",
};

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object" && "path" in input) return String((input as { path: unknown }).path);
  if (input && typeof input === "object" && "command" in input) {
    const { command, args } = input as { command: string; args?: string[] };
    return [command, ...(args ?? [])].join(" ");
  }
  return "";
}

export default function ToolReceiptView(props: { receipt: ToolReceipt }) {
  return (
    <div class="flex items-center gap-1.5 py-0.5 font-mono text-[11px] leading-none text-muted" data-tool-receipt={props.receipt.toolName} data-status={props.receipt.status}>
      <span class={`size-1.5 shrink-0 rounded-full ${statusDot[props.receipt.status]}`} />
      <span class="font-semibold text-fg">{props.receipt.toolName}</span>
      <span class="overflow-hidden text-ellipsis whitespace-nowrap">{summarizeInput(props.receipt.input)}</span>
    </div>
  );
}
