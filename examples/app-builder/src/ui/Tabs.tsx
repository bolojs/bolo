import { Tabs as TabsRoot, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PreviewTab = "preview" | "code";

interface Props {
  active: PreviewTab;
  onSelect(tab: PreviewTab): void;
}

export default function Tabs({ active, onSelect }: Props) {
  return (
    <TabsRoot value={active} onValueChange={(v) => onSelect(v as PreviewTab)}>
      <TabsList>
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
      </TabsList>
    </TabsRoot>
  );
}
