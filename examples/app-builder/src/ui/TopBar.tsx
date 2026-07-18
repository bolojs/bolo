import { Diamond, Download, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ThemeToggle from "./ThemeToggle";
import type { ContainerStatus } from "../container/useContainer";

type Theme = "dark" | "light";

interface Props {
  status: ContainerStatus;
  theme: Theme;
  onToggleTheme(): void;
  onOpenConfig(): void;
  onExport(): void;
  exportDisabled: boolean;
}

const STATUS_LABEL: Record<ContainerStatus, string> = {
  booting: "Booting…",
  installing: "Installing…",
  ready: "Ready",
  error: "Error",
};

const STATUS_DOT_CLASS: Record<ContainerStatus, string> = {
  booting: "bg-status-pending",
  installing: "bg-status-pending",
  ready: "bg-status-ok",
  error: "bg-status-error",
};

export default function TopBar({ status, theme, onToggleTheme, onOpenConfig, onExport, exportDisabled }: Props) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Diamond className="size-3.5 fill-foreground text-foreground" aria-hidden="true" />
          bolo
          <span className="font-normal text-muted-foreground">app builder</span>
        </div>
        <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
          <span className={`size-1.5 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
          {STATUS_LABEL[status]}
        </Badge>
      </div>
      <div className="flex items-center gap-1">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onOpenConfig} aria-label="Configure OpenRouter key & models">
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={onExport} disabled={exportDisabled} aria-label="Export project as .zip">
              <Download />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Export .zip</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
