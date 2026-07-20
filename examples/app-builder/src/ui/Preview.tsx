import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  url: string | null;
}

const PREVIEW_CHANNEL = "bolo-preview";
const PREVIEW_PATH = "/__preview/";

export default function Preview({ url }: Props) {
  const [controlled, setControlled] = useState(() => navigator.serviceWorker?.controller != null);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ponytail: without clients.claim() in the SW, the first page isn't SW-
  // controlled. The iframe might mount and navigate to /__preview/ BEFORE the
  // controller is set, falling through to vite (which returns app-builder's
  // HTML — React crashes inside the iframe and it ends up blank). Bumping the
  // key on controllerchange forces a remount AFTER SW takes control so the
  // iframe re-navigates and SW.onFetch routes it to BrowserViteServer.
  useEffect(() => {
    if (controlled || !navigator.serviceWorker) return;
    const onControllerChange = () => {
      setControlled(true);
      setIframeKey((k) => k + 1);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) {
        setControlled(true);
        setIframeKey((k) => k + 1);
      }
    });
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, [controlled]);

  // ponytail: BrowserViteServer is wired at boot with VFS auto-reload over a
  // BroadcastChannel. The iframe reloads itself when files change instead of
  // needing a @vite/client HMR runtime — fine for the app-builder use case
  // where every agent write should refresh what's shown.
  useEffect(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const bc = new BroadcastChannel(PREVIEW_CHANNEL);
    bc.onmessage = (e) => {
      if (e.data?.type !== "reload") return;
      const win = iframeRef.current?.contentWindow;
      if (win) {
        try {
          win.location.reload();
        } catch {
          // iframe may not be ready yet or cross-origin; next VFS change will retry
        }
      }
    };
    return () => bc.close();
  }, []);

  if (!controlled) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <p className="text-sm text-muted-foreground">Waiting for dev server…</p>
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  const src = url ?? new URL(PREVIEW_PATH, location.origin).href;

  // ponytail: belt-and-suspenders for the iframe-first-navigation race. Even
  // with the key remount on controllerchange, persistent/fresh sessions with
  // a SW already controlling render the iframe at mount time with src set —
  // but the iframe's first navigation can still 404 (Chrome shows the error
  // page) because the SW fetch handler isn't live yet. Force a cache-busted
  // re-navigation once the iframe is in the DOM so SW definitely sees it.
  // Memoized on `src` so re-renders don't queue a fresh setTimeout each
  // commit — without this every render called old(null)+new(el) on the ref,
  // each `el` scheduling its own cache-buster that aborted the prior
  // in-flight load (Firefox: NS_BINDING_ABORTED -> CORRUPTED_CONTENT cascade).
  const setIframeNode = useCallback((el: HTMLIFrameElement | null) => {
    iframeRef.current = el;
    if (!el) return;
    setTimeout(() => {
      if (!iframeRef.current) return;
      const fresh = src + (src.includes("?") ? "&" : "?") + "_=" + Date.now();
      if (iframeRef.current.src !== fresh) iframeRef.current.src = fresh;
    }, 250);
  }, [src]);

  return <iframe key={iframeKey} ref={setIframeNode} src={src} title="preview" className="h-full w-full border-none bg-white" />;
}
