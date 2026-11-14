/** @jsxImportSource solid-js */
import { createSignal, JSX, onCleanup } from "solid-js";

interface Props {
  direction: "row" | "column";
  /** Initial size of the first pane, as a fraction between 0 and 1. */
  initialRatio?: number;
  min?: number;
  max?: number;
  first: JSX.Element;
  second: JSX.Element;
  /** Test hook: rendered on the outer element. */
  dataPanel?: string;
}

/**
 * Dependency-light two-pane splitter driven by pointer events. Ratio is
 * stored as a CSS `flex-basis` percentage so panes reflow on container
 * resize for free.
 */
export default function SplitPane(props: Props) {
  const [ratio, setRatio] = createSignal(props.initialRatio ?? 0.5);
  const min = () => props.min ?? 0.15;
  const max = () => props.max ?? 0.85;
  let wrap!: HTMLDivElement;
  let dragging = false;

  const onPointerDown = (event: PointerEvent) => {
    dragging = true;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) return;
    const rect = wrap.getBoundingClientRect();
    const raw =
      props.direction === "row"
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    setRatio(Math.min(max(), Math.max(min(), raw)));
  };
  const stop = () => {
    dragging = false;
  };

  const isRow = () => props.direction === "row";
  const gutterClass = () =>
    isRow()
      ? "w-1.5 shrink-0 cursor-col-resize touch-none"
      : "h-1.5 shrink-0 cursor-row-resize touch-none";

  // Attach move/up on window so drags keep working past the gutter bounds.
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    onCleanup(() => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
    });
  }

  return (
    <div
      ref={wrap}
      data-panel={props.dataPanel}
      class="flex h-full min-h-0 w-full overflow-hidden"
      classList={{ "flex-row": isRow(), "flex-col": !isRow() }}
    >
      <div class="min-h-0 min-w-0 overflow-hidden" style={{ flex: `0 1 ${ratio() * 100}%` }}>
        {props.first}
      </div>
      <div
        role="separator"
        aria-orientation={isRow() ? "vertical" : "horizontal"}
        class={`${gutterClass()} bg-[color-mix(in_srgb,var(--fg)_6%,transparent)] hover:bg-[var(--accent)]`}
        onPointerDown={onPointerDown}
      />
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">{props.second}</div>
    </div>
  );
}
