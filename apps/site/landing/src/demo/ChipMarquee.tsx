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
  const chip = (action: QuickAction) => {
    const isDisabled = props.disabled || !!action.reason;
    return (
      <button
        type="button"
        ref={pressAnimate}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        title={action.reason ?? (props.disabled ? "waiting for runtime…" : undefined)}
        onClick={() => !isDisabled && props.onRun(action)}
        class="rounded-xl border border-border bg-white px-3.5 py-1.5 text-[12px] font-medium text-fg transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#f5f5f5] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white"
      >
        {action.label}
      </button>
    );
  };

  return <div class="flex flex-wrap gap-2">{props.actions.map((action) => chip(action))}</div>;
}
