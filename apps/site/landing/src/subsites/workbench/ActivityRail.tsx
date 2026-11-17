/** @jsxImportSource solid-js */
import { For } from "solid-js";
import type { SidebarView } from "./types";

interface Props {
  views: SidebarView[];
  /** Currently shown view, or null when the sidebar is collapsed. */
  activeId: string | null;
  /** Selecting the active view collapses the sidebar; another switches to it. */
  onSelect(id: string): void;
}

/** VSCode-style activity rail: one icon button per sidebar view. */
export default function ActivityRail(props: Props) {
  return (
    <nav
      data-panel="activity-rail"
      aria-label="Activity bar"
      class="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border py-2"
    >
      <For each={props.views}>
        {(view) => (
          <button
            type="button"
            title={view.title}
            aria-label={view.title}
            aria-pressed={view.id === props.activeId}
            class={`flex size-8 items-center justify-center rounded-lg text-[15px] leading-none transition-colors ${
              view.id === props.activeId
                ? "bg-[color-mix(in_srgb,var(--fg)_8%,transparent)] text-fg"
                : "text-muted hover:bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] hover:text-fg"
            }`}
            onClick={() => props.onSelect(view.id)}
          >
            {view.icon ?? view.title.slice(0, 1).toUpperCase()}
          </button>
        )}
      </For>
    </nav>
  );
}
