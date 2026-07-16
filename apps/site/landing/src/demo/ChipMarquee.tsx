/** @jsxImportSource solid-js */
import { animate } from "motion";
import { onCleanup, onMount } from "solid-js";
import type { QuickAction } from "./scenarios";

interface Props {
  actions: QuickAction[];
  disabled: boolean;
  onRun(action: QuickAction): void;
}

const AUTO_SCROLL_PX_PER_SEC = 24;
const RESUME_DELAY_MS = 2500;

const pressAnimate = (el: HTMLButtonElement) => {
  el.addEventListener("pointerdown", () =>
    animate(el, { scaleX: 0.96, scaleY: 0.96 }, { duration: 0.1 }),
  );
  el.addEventListener("pointerup", () =>
    animate(el, { scaleX: 1, scaleY: 1 }, { duration: 0.15, ease: "easeOut" }),
  );
  el.addEventListener("pointerleave", () =>
    animate(el, { scaleX: 1, scaleY: 1 }, { duration: 0.15, ease: "easeOut" }),
  );
};

export default function ChipMarquee(props: Props) {
  let scroller: HTMLDivElement | undefined;
  let track: HTMLDivElement | undefined;
  let rafId: number | undefined;
  let lastTs: number | undefined;
  let paused = false;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  // Tracked in full float precision — `scroller.scrollLeft` rounds to whole
  // device pixels on read, which would stall sub-pixel-per-frame increments.
  let scrollPos = 0;

  const pauseAutoScroll = () => {
    paused = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      paused = false;
    }, RESUME_DELAY_MS);
  };

  // Content is duplicated x2 below so the scroll position can wrap seamlessly
  // in either direction once it crosses the halfway point of the track.
  const normalizeLoop = () => {
    if (!scroller || !track) return;
    const half = track.scrollWidth / 2;
    if (half <= 0) return;
    if (scrollPos >= half) {
      scrollPos -= half;
      scroller.scrollLeft = scrollPos;
    } else if (scrollPos < 0) {
      scrollPos += half;
      scroller.scrollLeft = scrollPos;
    }
  };

  const tick = (ts: number) => {
    if (scroller && !paused && !document.hidden) {
      const dt = lastTs === undefined ? 0 : ts - lastTs;
      scrollPos += (AUTO_SCROLL_PX_PER_SEC * dt) / 1000;
      scroller.scrollLeft = scrollPos;
      normalizeLoop();
    }
    lastTs = ts;
    rafId = requestAnimationFrame(tick);
  };

  onMount(() => {
    if (scroller) scrollPos = scroller.scrollLeft;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    rafId = requestAnimationFrame(tick);
  });

  onCleanup(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (resumeTimer) clearTimeout(resumeTimer);
  });

  const chip = (action: QuickAction, key: string) => {
    const isDisabled = props.disabled || !!action.reason;
    return (
      <button
        type="button"
        ref={pressAnimate}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        tabIndex={key.endsWith(":1") ? -1 : 0}
        aria-hidden={key.endsWith(":1") ? true : undefined}
        title={action.reason ?? (props.disabled ? "waiting for runtime…" : undefined)}
        onClick={() => !isDisabled && props.onRun(action)}
        class="rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-1.5 text-[12px] font-medium text-fg whitespace-nowrap transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[color-mix(in_srgb,var(--fg)_6%,var(--surface-2))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[var(--surface-2)]"
      >
        {action.label}
      </button>
    );
  };

  return (
    <div
      ref={scroller}
      class="overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onPointerDown={pauseAutoScroll}
      onWheel={pauseAutoScroll}
      onTouchStart={pauseAutoScroll}
      onScroll={normalizeLoop}
    >
      <div ref={track} class="flex w-max flex-nowrap gap-2">
        {props.actions.map((action) => chip(action, `${action.label}:0`))}
        {props.actions.map((action) => chip(action, `${action.label}:1`))}
      </div>
    </div>
  );
}
