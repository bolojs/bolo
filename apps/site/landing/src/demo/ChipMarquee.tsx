/** @jsxImportSource solid-js */
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
    <div class="overflow-hidden">
      <div class="marquee-track flex w-max flex-nowrap gap-2">
        {props.actions.map((action) => chip(action, `${action.label}:0`))}
        {props.actions.map((action) => chip(action, `${action.label}:1`))}
      </div>
    </div>
  );
}
