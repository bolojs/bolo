/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount } from "solid-js";

interface Props {
  url: string | null;
}

const PREVIEW_CHANNEL = "bolo-preview";

/**
 * Preview panel: plain iframe on the preview URL, hardened for the
 * service-worker races that make a naive iframe flaky here.
 *
 * - The iframe only mounts once a service worker controls the page; without
 *   clients.claim() the first navigation to /__preview/ would fall through to
 *   the static host and show a 404.
 * - Reloads are driven by the runtime: VfsBus writes trigger
 *   BrowserViteServer.broadcastHmr plus a debounced {type:"reload"} on the
 *   "bolo-preview" BroadcastChannel, which this panel receives and turns into
 *   iframe.location.reload() (same-origin, so the content window is reachable).
 * - The first in-DOM navigation can still race the SW fetch handler, so we
 *   force one cache-busted re-navigation shortly after mount.
 */
export default function Preview(props: Props) {
  const [controlled, setControlled] = createSignal(
    typeof navigator === "undefined" || navigator.serviceWorker?.controller != null,
  );
  let iframe: HTMLIFrameElement | undefined;
  let remountedFor = "";

  onMount(() => {
    if (!navigator.serviceWorker || controlled()) return;
    const onControllerChange = () => {
      setControlled(true);
      remountedFor = "";
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) setControlled(true);
    });
    onCleanup(() =>
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange),
    );
  });

  onMount(() => {
    if (!("BroadcastChannel" in globalThis)) return;
    const channel = new BroadcastChannel(PREVIEW_CHANNEL);
    channel.onmessage = (event) => {
      if (event.data?.type !== "reload") return;
      try {
        iframe?.contentWindow?.location.reload();
      } catch {
        // iframe not ready yet; the next VFS change retries.
      }
    };
    onCleanup(() => channel.close());
  });

  const setIframeNode = (el: HTMLIFrameElement) => {
    iframe = el;
    if (!el) return;
    const src = props.url;
    if (!src || remountedFor === src) return;
    remountedFor = src;
    // Cache-bust once per src so the SW fetch handler definitely sees the
    // navigation (first loads can otherwise hit the network and 404).
    setTimeout(() => {
      if (!iframe) return;
      const fresh = src + (src.includes("?") ? "&" : "?") + "_=" + Date.now();
      if (iframe.src !== fresh) iframe.src = fresh;
    }, 250);
  };

  return (
    <div data-panel="preview" class="flex h-full min-h-0 items-center justify-center overflow-hidden">
      {props.url && controlled() ? (
        <iframe title="Preview" data-preview ref={setIframeNode} src={props.url} class="h-full w-full border-0 bg-white" />
      ) : (
        <p class="max-w-[26ch] px-4 text-center text-[12.5px] leading-relaxed text-muted">
          {props.url ? "Waiting for the dev server…" : "No server yet. Run one from the terminal to see it here."}
        </p>
      )}
    </div>
  );
}
