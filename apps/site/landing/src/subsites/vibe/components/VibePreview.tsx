/** @jsxImportSource solid-js */
import { createSignal } from "solid-js";

/**
 * Preview for the vibe subsite. The subsite service worker is scoped to
 * "/vibe/", and the runtime mounts its preview under "<scope>__preview/"
 * (runtime-builder.ts). A plain iframe navigation to the scope-prefixed URL
 * would work, but subresource fetches outside the controlling SW's scope are
 * not intercepted, so a bare "/__preview/" fetch bypasses every service
 * worker and 404s. Fetching "vibe/__preview/" relative to the page URL lands
 * inside the controlling scope, and the document is injected as srcdoc with
 * a <base> pointing at the same prefix so its subresources stay in scope.
 */
const PREVIEW_BASE = new URL("__preview/", globalThis.location.href).pathname;
export const createVibePreview = () => {
  const [html, setHtml] = createSignal<string | null>(null);

  const refresh = async (): Promise<void> => {
    const res = await fetch(PREVIEW_BASE, { cache: "no-store" });
    if (!res.ok) throw new Error(`Preview server responded ${res.status}`);
    const text = await res.text();
    setHtml(
      text.includes("<head>")
        ? text.replace("<head>", `<head><base href="${PREVIEW_BASE}">`)
        : `<base href="${PREVIEW_BASE}">${text}`,
    );
  };

  return { html, refresh };
};

interface Props {
  html: string | null;
}

export default function VibePreview(props: Props) {
  return (
    <div data-panel="preview" class="flex h-full min-h-0 items-center justify-center overflow-hidden">
      {props.html ? (
        <iframe title="Preview" data-preview srcdoc={props.html} class="h-full w-full border-0 bg-white" />
      ) : (
        <p class="max-w-[26ch] px-4 text-center text-[12.5px] leading-relaxed text-muted">
          No server yet. Ask the assistant to build something and start the dev server.
        </p>
      )}
    </div>
  );
}
