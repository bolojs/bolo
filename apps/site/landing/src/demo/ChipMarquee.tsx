/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount } from "solid-js";
import { animate } from "motion";
import type { QuickAction } from "./scenarios";

interface Props {
  actions: QuickAction[];
  disabled: boolean;
  onRun(action: QuickAction): void;
}

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
  let trackRef!: HTMLDivElement;
  let contentRef!: HTMLDivElement;
  const [overflowing, setOverflowing] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(false);

  onMount(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);

    const check = () => setOverflowing(contentRef.scrollWidth > trackRef.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(trackRef);
    ro.observe(contentRef);

    onCleanup(() => {
      ro.disconnect();
      mq.removeEventListener("change", onChange);
    });
  });

  const shouldAnimate = () => overflowing() && !reducedMotion() && !props.disabled;

  const chip = (action: QuickAction, duplicate: boolean) => {
    const isDisabled = props.disabled || !!action.reason;
    return (
      <button
        type="button"
        ref={duplicate ? undefined : pressAnimate}
        tabindex={duplicate ? -1 : 0}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        title={action.reason ?? (props.disabled ? "waiting for runtime…" : undefined)}
        onClick={() => !isDisabled && props.onRun(action)}
        class="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-medium text-fg transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-white/20 hover:bg-white/[0.08] hover:text-fg active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04] disabled:hover:text-fg"
      >
        {action.label}
      </button>
    );
  };

  return (
    <div
      ref={trackRef}
      class="min-w-0 overflow-hidden rounded-full bg-white/[0.03] px-3 py-1.5 ring-1 ring-white/[0.08] shadow-[inset_0_1px_1px_rgba(255,255,255,0.04)]"
      classList={{ "overflow-x-auto": reducedMotion() && overflowing() }}
    >
      <div class="flex w-max gap-2" classList={{ "animate-marquee": shouldAnimate() }}>
        <div class="flex shrink-0 gap-2" ref={contentRef}>
          {props.actions.map((action) => chip(action, false))}
        </div>
        {shouldAnimate() && (
          <div class="flex shrink-0 gap-2" aria-hidden="true">
            {props.actions.map((action) => chip(action, true))}
          </div>
        )}
      </div>
    </div>
  );
}
