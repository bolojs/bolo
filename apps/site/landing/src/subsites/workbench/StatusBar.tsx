/** @jsxImportSource solid-js */
import { For } from "solid-js";
import type { StatusItem, WorkbenchContext } from "./types";

interface Props {
  items: StatusItem[];
  ctx: WorkbenchContext;
}

/** Workbench status bar: left-side state items, right-side toggles. */
export default function StatusBar(props: Props) {
  const left = () => props.items.filter((item) => item.side === "left");
  const right = () => props.items.filter((item) => item.side === "right");
  return (
    <footer
      data-panel="status-bar"
      class="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[11.5px] leading-none text-muted"
    >
      <For each={left()}>{(item) => item.render(props.ctx)}</For>
      <span class="ml-auto" />
      <For each={right()}>{(item) => item.render(props.ctx)}</For>
    </footer>
  );
}
