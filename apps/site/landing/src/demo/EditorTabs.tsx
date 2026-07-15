/** @jsxImportSource solid-js */
export type EditorTab = "code" | "preview";

interface Props {
  activeTab: EditorTab;
  servesHttp: boolean;
  fileName: string;
  onSelect(tab: EditorTab): void;
}

const tabBase = "rounded-lg px-3.5 py-1.5 text-[13px] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

export default function EditorTabs(props: Props) {
  return (
    <div class="flex shrink-0 items-center gap-1 border-b border-border bg-[color-mix(in_srgb,var(--fg)_4%,transparent)] p-1.5">
      <button
        type="button"
        onClick={() => props.onSelect("code")}
        class={`${tabBase} ${props.activeTab === "code" ? "bg-[var(--surface-2)] font-medium text-fg shadow-sm" : "text-muted hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]"}`}
      >
        {props.fileName}
      </button>
      <button
        type="button"
        disabled={!props.servesHttp}
        aria-disabled={!props.servesHttp}
        title={props.servesHttp ? undefined : "This scenario doesn't run a server"}
        onClick={() => props.servesHttp && props.onSelect("preview")}
        class={`${tabBase} ${props.activeTab === "preview" ? "bg-[var(--surface-2)] font-medium text-fg shadow-sm" : "text-muted hover:bg-[color-mix(in_srgb,var(--fg)_6%,transparent)]"} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent`}
      >
        🌎 preview
      </button>
    </div>
  );
}
