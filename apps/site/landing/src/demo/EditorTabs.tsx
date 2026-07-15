/** @jsxImportSource solid-js */
export type EditorTab = "code" | "preview";

interface Props {
  activeTab: EditorTab;
  servesHttp: boolean;
  onSelect(tab: EditorTab): void;
}

const tabBase = "px-4 py-2 text-[13px] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

export default function EditorTabs(props: Props) {
  return (
    <div class="flex shrink-0 items-center border-b border-border">
      <button
        type="button"
        onClick={() => props.onSelect("code")}
        class={`${tabBase} border-r border-border ${props.activeTab === "code" ? "bg-white font-medium text-fg" : "text-muted hover:bg-[var(--surface-1,#f5f5f5)]"}`}
      >
        index.js
      </button>
      <button
        type="button"
        disabled={!props.servesHttp}
        aria-disabled={!props.servesHttp}
        title={props.servesHttp ? undefined : "This scenario doesn't run a server"}
        onClick={() => props.servesHttp && props.onSelect("preview")}
        class={`${tabBase} ${props.activeTab === "preview" ? "bg-white font-medium text-fg" : "text-muted hover:bg-[var(--surface-1,#f5f5f5)]"} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent`}
      >
        🌎 preview
      </button>
    </div>
  );
}
