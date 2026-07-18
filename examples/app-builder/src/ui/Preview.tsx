import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  url: string | null;
}

export default function Preview({ url }: Props) {
  const [controlled, setControlled] = useState(() => navigator.serviceWorker?.controller != null);

  useEffect(() => {
    if (controlled || !navigator.serviceWorker) return;
    const onControllerChange = () => setControlled(true);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) setControlled(true);
    });
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, [controlled]);

  if (!url || !controlled) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <p className="text-sm text-muted-foreground">Waiting for dev server…</p>
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  return <iframe src={url} title="preview" className="h-full w-full border-none bg-white" />;
}
