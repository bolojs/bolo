import { installMainRelay, installObsBuffer, type BrowserContainer } from "@bolojs/runtime";
import type { BoloError } from "@bolojs/log/error-hints";

export interface SwErrorTracker {
  /** Drain every observed error record (page, worker, SW) recorded so far. */
  drain: () => BoloError[];
  /** Drain and return only service-worker-sourced errors. */
  drainSwErrors: () => BoloError[];
}

/**
 * Install the page-global observability buffer so SW errors forwarded over
 * the INIT_PORT channel (BOLO_SW_ERROR) become visible on the main thread.
 * Idempotent; safe to call once per subsite page.
 */
export const installSwErrorTracking = (): SwErrorTracker => {
  installObsBuffer();
  installMainRelay();
  const drain = (): BoloError[] =>
    (globalThis as unknown as { __boloObsDrain?: () => BoloError[] }).__boloObsDrain?.() ?? [];
  return {
    drain,
    drainSwErrors: () => drain().filter((record) => record.source === "sw"),
  };
};

export interface PreviewListener {
  url: string;
}

/**
 * Subscribe to the container's preview URL when a server announces itself.
 * Note: the runtime emits its initial "server-ready" (the "/__preview/"
 * base) during boot() itself, before callers can attach a listener; stubs
 * therefore leave the preview empty until a user server starts. WP2 wires
 * the Vite template where the preview base serves an index.html.
 */
export const observePreviewUrl = (
  container: BrowserContainer,
  onUrl: (url: string) => void,
): void => {
  container.on("server-ready", (_port, url) => {
    onUrl(new URL(url, globalThis.location.origin).toString());
  });
};
