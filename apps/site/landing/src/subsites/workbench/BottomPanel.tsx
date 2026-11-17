/** @jsxImportSource solid-js */
import { For } from "solid-js";
import type { PanelView } from "./types";

interface Props {
  panels: PanelView[];
  activeId: string | null;
  onSelect(id: string): void;
  onCollapse(): void;
}

/**
 * Collapsible bottom panel. Panel bodies stay mounted and hidden while
 * inactive so terminal scrollback and xterm state survive view switches;
 * collapsing the whole region is handled by the shell (which re-inserts the
 * same DOM on reopen).
 */
export default function BottomPanel(props: Props) {
  return (
    <div data-panel="bottom" class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex h-8 shrink-0 items-center gap-2 border-t border-border px-2">
        <For each={props.panels}>
          {(panel) => (
            <button
              type="button"
              class={`px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                panel.id === props.activeId ? "text-fg" : "text-muted hover:text-fg"
              }`}
              onClick={() => props.onSelect(panel.id)}
            >
              {panel.title}
            </button>
          )}
        </For>
        <button
          type="button"
          aria-label="Collapse panel"
          title="Collapse panel"
          class="ml-auto rounded px-1.5 py-0.5 text-[13px] leading-none text-muted hover:text-fg"
          onClick={() => props.onCollapse()}
        >
          ▾
        </button>
      </div>
      <div class="relative min-h-0 flex-1">
        <For each={props.panels}>
          {(panel) => (
            <div
              classList={{
                hidden: panel.id !== props.activeId,
                "flex h-full min-h-0 flex-col": panel.id === props.activeId,
              }}
            >
              {panel.render()}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
