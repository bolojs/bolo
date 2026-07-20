import { createSignal, Show, onMount, onCleanup } from "solid-js";

interface Props {
  url: string | null;
}

const PREVIEW_CHANNEL = "bolo-preview";
const PREVIEW_PATH = "/__preview/";

// ponytail: Solid has no `key` prop for forcing remounts like React's iframeKey.
// `<Show when={key()} keyed>` recreates its child when the value changes —
// equivalent semantics, less ceremony.
export default function Preview(props: Props) {
  const [controlled, setControlled] = createSignal(navigator.serviceWorker?.controller != null);
  const [iframeKey, setIframeKey] = createSignal(0);
  let iframe: HTMLIFrameElement | null = null;

  onMount(() => {
    // ponytail: without clients.claim() in the SW, the first page isn't SW-
    // controlled. The iframe might mount and navigate to /__preview/ BEFORE the
    // controller is set, falling through to vite (which returns app-builder's
    // HTML — crashes inside the iframe, ends up blank). Bumping the key on
    // controllerchange forces a remount AFTER SW takes control so the iframe
    // re-navigates and SW.onFetch routes it to BrowserViteServer.
    if (controlled() || !navigator.serviceWorker) return;
    const onControllerChange = () => {
      setControlled(true);
      setIframeKey((k) => k + 1);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker?.controller) {
        setControlled(true);
        setIframeKey((k) => k + 1);
      }
    });
    onCleanup(() => navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange));

    // ponytail: BrowserViteServer wires VFS auto-reload over a BroadcastChannel.
    // The iframe reloads itself on file changes instead of needing @vite/client
    // HMR — fine for app-builder where every agent write should refresh.
    if (!("BroadcastChannel" in globalThis)) return;
    const bc = new BroadcastChannel(PREVIEW_CHANNEL);
    bc.onmessage = (e) => {
      if (e.data?.type !== "reload") return;
      const win = iframe?.contentWindow;
      if (win) {
        try {
          win.location.reload();
        } catch {
          // iframe may not be ready or cross-origin; next VFS change will retry
        }
      }
    };
    onCleanup(() => bc.close());
  });

  // ponytail: belt-and-suspenders for the iframe-first-navigation race. Even
  // with the key remount on controllerchange, sessions with a SW already
  // controlling render the iframe at mount with src set — but the iframe's
  // first navigation can still 404 (Chrome shows the error page) because the
  // SW fetch handler isn't live yet. Force a cache-busted re-navigation once
  // the iframe is in the DOM so SW definitely sees it. In Solid, ref callbacks
  // are plain assignments (not recreated per render like unmemoized React ref
  // callbacks), so the cache-buster fires exactly once — the
  // NS_BINDING_ABORTED → CORRUPTED_CONTENT cascade we hit in the React
  // version can't happen here.
  const setIframeNode = (el: HTMLIFrameElement | null) => {
    iframe = el;
    if (!el) return;
    setTimeout(() => {
      if (!iframe) return;
      const src = props.url ?? new URL(PREVIEW_PATH, location.origin).href;
      const fresh = src + (src.includes("?") ? "&" : "?") + "_=" + Date.now();
      if (iframe.src !== fresh) iframe.src = fresh;
    }, 250);
  };

  return (
    <Show
      when={controlled()}
      fallback={
        <div class="flex h-full flex-col gap-2 p-3">
          <p class="text-sm text-muted-foreground">Waiting for dev server…</p>
          <div class="h-full w-full animate-pulse rounded bg-muted" />
        </div>
      }
    >
      <Show when={iframeKey()} keyed>
        <iframe
          ref={setIframeNode}
          src={props.url ?? new URL(PREVIEW_PATH, location.origin).href}
          title="preview"
          class="h-full w-full border-none bg-white"
        />
      </Show>
    </Show>
  );
}
