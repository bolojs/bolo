import { Diamond, Download, Settings } from "lucide-solid";
import type { Component } from "solid-js";
import ThemeToggle, { type Theme } from "./ThemeToggle";

export type Status = "booting" | "installing" | "ready" | "error";

interface Props {
  status: Status;
  theme: Theme;
  onToggleTheme(): void;
  onOpenConfig(): void;
  onExport(): void;
  exportDisabled: boolean;
}

const STATUS_LABEL: Record<Status, string> = {
  booting: "Booting…",
  installing: "Installing…",
  ready: "Ready",
  error: "Error",
};

const STATUS_DOT_CLASS: Record<Status, string> = {
  booting: "bg-status-pending",
  installing: "bg-status-pending",
  ready: "bg-status-ok",
  error: "bg-status-error",
};

// ponytail: plain <header>/<button> over shadcn Badge + Button + Tooltip.
// Status pill = <span> with same Tailwind classes; tooltips = title=
// attribute; icon buttons = native <button>. Drops 3 Radix primitives.
const TopBar: Component<Props> = (props) => {
  return (
    <header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      <div class="flex items-center gap-1.5 sm:gap-3">
        <div class="flex items-center gap-1.5 text-sm font-semibold">
          <Diamond class="size-3.5 fill-foreground text-foreground" aria-hidden="true" />
          bolo
          <span class="hidden font-normal text-muted-foreground sm:inline">app builder</span>
        </div>
        <span class="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-normal text-xs text-muted-foreground">
          <span class={`size-1.5 rounded-full ${STATUS_DOT_CLASS[props.status]}`} aria-hidden="true" />
          <span class="hidden sm:inline">{STATUS_LABEL[props.status]}</span>
        </span>
      </div>
      <div class="flex items-center gap-1">
        <ThemeToggle theme={props.theme} onToggle={() => props.onToggleTheme()} />
        <button
          type="button"
          class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => props.onOpenConfig()}
          title="Settings"
          aria-label="Configure OpenRouter key & models"
        >
          <Settings class="size-4" />
        </button>
        <button
          type="button"
          class="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() => props.onExport()}
          disabled={props.exportDisabled}
          title="Export .zip"
          aria-label="Export project as .zip"
        >
          <Download class="size-4" />
        </button>
      </div>
    </header>
  );
};

export default TopBar;
