import { createEffect, onCleanup } from "solid-js";

interface Props {
  url: string;
}

export default function Preview(props: Props) {
  let iframeRef: HTMLIFrameElement | undefined;

  // Listen for HMR reload signals broadcast by BrowserViteServer.
  createEffect(() => {
    const channel = new BroadcastChannel("vite-hmr");
    const onMessage = () => {
      if (iframeRef?.contentWindow) iframeRef.contentWindow.location.reload();
    };
    channel.addEventListener("message", onMessage);
    onCleanup(() => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    });
  });

  createEffect(() => {
    if (props.url && iframeRef) {
      iframeRef.src = props.url;
    }
  });

  return (
    <section class="preview">
      <iframe
        ref={iframeRef}
        class="preview-frame"
        data-preview
        sandbox="allow-scripts allow-forms allow-same-origin"
        title="Preview"
      />
      {!props.url && (
        <div class="preview-placeholder">
          Preview loads here after <code>npm run dev</code>
        </div>
      )}
    </section>
  );
}
