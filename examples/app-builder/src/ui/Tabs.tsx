import { Tabs as TabsRoot, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PreviewTab = "preview" | "code" | "chat" | "terminal";

interface Props {
  active: PreviewTab;
  onSelect(tab: PreviewTab): void;
  mobile?: boolean;
}

export default function Tabs({ active, onSelect, mobile }: Props) {
  return (
    <TabsRoot value={active} onValueChange={(v) => onSelect(v as PreviewTab)}>
      <TabsList>
        {mobile && <TabsTrigger value="chat">Chat</TabsTrigger>}
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
        {mobile && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
      </TabsList>
    </TabsRoot>
  );
}
