import { type Component, For } from "solid-js";
import { cn } from "../lib/utils";

export type PreviewTab = "preview" | "code" | "chat" | "terminal";

interface Props {
  active: PreviewTab;
  onSelect: (tab: PreviewTab) => void;
  mobile?: boolean;
}

/**
 * Solid port of `examples/app-builder/src/ui/Tabs.tsx`.
 * Drops shadcn `Tabs`/`TabsList`/`TabsTrigger` (Radix primitive) for
 * plain `<button>`s with the same Tailwind treatment (ponytail: native
 * first; the Radix wrapper added keyboard nav we don't need for 4 tabs).
 */
const Tabs: Component<Props> = (props) => {
  const items = (): { id: PreviewTab; label: string }[] => {
    const list: { id: PreviewTab; label: string }[] = [];
    if (props.mobile) list.push({ id: "chat", label: "Chat" });
    list.push({ id: "preview", label: "Preview" });
    list.push({ id: "code", label: "Code" });
    if (props.mobile) list.push({ id: "terminal", label: "Terminal" });
    return list;
  };

  return (
    <div class="flex items-center gap-1">
      <For each={items()}>
        {(item) => (
          <button
            type="button"
            class={cn(
              "rounded-md px-3 py-1 text-[12px] transition-colors",
              props.active === item.id
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => props.onSelect(item.id)}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default Tabs;
