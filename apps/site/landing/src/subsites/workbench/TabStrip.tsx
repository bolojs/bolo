/** @jsxImportSource solid-js */
import { For } from "solid-js";
import type { WorkbenchTab } from "./types";

interface Props {
  tabs: WorkbenchTab[];
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
}

/**
 * Heterogeneous tab strip over the main area: code, request, preview and
 * custom tabs share one strip. The active tab merges into the body below
 * (its bottom edge sits on the strip border).
 */
export default function TabStrip(props: Props) {
  return (
    <div
      data-panel="workbench-tabs"
      role="tablist"
      class="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-[color-mix(in_srgb,var(--fg)_3%,transparent)] px-2"
    >
      <For each={props.tabs}>
        {(tab) => {
          const active = () => tab.id === props.activeId;
          return (
            <div
              class={`flex h-7 shrink-0 items-center gap-1 rounded-t-md border-x border-t px-2.5 ${
                active()
                  ? "-mb-px border-border border-b-[var(--surface-2)] bg-[var(--surface-2)]"
                  : "border-transparent"
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active()}
                class={`flex items-center gap-1.5 text-[12px] transition-colors ${
                  active() ? "font-medium text-fg" : "text-muted hover:text-fg"
                }`}
                onClick={() => props.onActivate(tab.id)}
              >
                {tab.dirty ? <span class="size-1.5 rounded-full bg-[var(--accent)]" /> : null}
                {tab.title}
              </button>
              {tab.closable !== false && (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  class="rounded px-0.5 text-[11px] text-muted hover:text-fg"
                  onClick={() => props.onClose(tab.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
}
