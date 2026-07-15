/** @jsxImportSource solid-js */
export type EditorTab = "code" | "preview";

interface Props {
  activeTab: EditorTab;
  servesHttp: boolean;
  onSelect(tab: EditorTab): void;
}

const tabBase =
  "rounded-full px-3 py-1.5 text-[12px] font-medium uppercase tracking-[0.08em] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

export default function EditorTabs(props: Props) {
  return (
    <div class="flex shrink-0 items-center gap-1 border-b border-white/10 px-2.5 py-2">
      <button
        type="button"
        onClick={() => props.onSelect("code")}
        class={`${tabBase} ${props.activeTab === "code" ? "bg-white/[0.08] text-fg shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]" : "text-muted hover:text-fg"}`}
      >
        index.js
      </button>
      <button
        type="button"
        disabled={!props.servesHttp}
        aria-disabled={!props.servesHttp}
        title={props.servesHttp ? undefined : "This scenario doesn't run a server"}
        onClick={() => props.servesHttp && props.onSelect("preview")}
        class={`${tabBase} ${props.activeTab === "preview" ? "bg-white/[0.08] text-fg shadow-[inset_0_1px_1px_rgba(255,255,255,0.06)]" : "text-muted hover:text-fg"} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-muted`}
      >
        🌎 preview
      </button>
    </div>
  );
}
