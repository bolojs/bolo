/**
 * Cross-context error relay + page-global `__boloObs` ring buffer.
 *
 * The main thread owns the buffer; every other realm (Worker, SW, preview
 * iframe) sends records here. Exposes `__boloObsDrain()` so the existing
 * pw-observe harness and DevTools consoles can read it without Playwright
 * listener plumbing. Also broadcasts over `BroadcastChannel("bolo-errors")`
 * so future devtools panels can subscribe.
 *
 * ponytail: SW-side `addEventListener("error"/"unhandledrejection")` is the
 * next thing to add — packages/sw-sandbox/src/sw.ts posts
 * { type: "SW_ERROR", error: <BoloError> } to its mainPort, and
 * sw-sandbox.ts pushes it through __boloObsPush. Worker-side relay
 * (extract worker-script.ts:106-123) is a follow-up; not blocking the
 * demo fix.
 */

import { getLogger } from "@bolojs/log/browser";
import type { BoloError } from "@bolojs/log/error-hints";

const logger = getLogger(["bolo", "runtime", "error-relay"]);
const BUFFER_SIZE = 200;
const CHANNEL_NAME = "bolo-errors";

export interface ObsBuffer {
  push: (record: BoloError) => void;
  drain: () => BoloError[];
}

const createObsBuffer = (): ObsBuffer => {
  const buffer: BoloError[] = [];
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

  return {
    push(record) {
      buffer.push(record);
      if (buffer.length > BUFFER_SIZE) buffer.shift();
      channel?.postMessage(record);
      logger.error("obs", { ...record });
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
  };
};

let installed: ObsBuffer | null = null;

/**
 * Install the page-global `__boloObs` ring buffer. Idempotent: re-calls
 * return the existing instance (safe under React StrictMode / HMR).
 */
export const installObsBuffer = (): ObsBuffer => {
  if (installed) return installed;
  const buf = createObsBuffer();
  (globalThis as unknown as { __boloObs?: BoloError[] }).__boloObs = [];
  (globalThis as unknown as { __boloObsDrain?: () => BoloError[] }).__boloObsDrain = () =>
    buf.drain();
  (globalThis as unknown as { __boloObsPush?: (r: BoloError) => void }).__boloObsPush = (
    r: BoloError,
  ) => buf.push(r);
  installed = buf;
  return buf;
};

export const getObsBuffer = (): ObsBuffer | null => installed;

/** Install window error + unhandledrejection listeners on the main thread. */
export const installMainRelay = (): ObsBuffer => {
  const buf = installObsBuffer();

  globalThis.addEventListener("error", (event: ErrorEvent) => {
    buf.push({
      kind: "unknown",
      source: "main",
      message: event.message || String(event.error ?? "unknown error"),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      ts: Date.now(),
    });
  });

  globalThis.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    buf.push({
      kind: "unknown",
      source: "main",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      cause:
        reason instanceof Error && reason.cause instanceof Error ? reason.cause.message : undefined,
      ts: Date.now(),
    });
  });

  return buf;
};

/**
 * Format an error caught inside a ServiceWorker. sw.ts posts the result
 * via mainPort.postMessage({ type: "SW_ERROR", error: <BoloError> });
 * sw-sandbox.ts forwards it to __boloObsPush.
 */
export const formatSWError = (kind: "error" | "unhandledrejection", err: unknown): BoloError => ({
  kind: "sw",
  source: "sw",
  message: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
  stack: err instanceof Error ? err.stack : undefined,
  ts: Date.now(),
});

/** Wire name SW scripts post to mainPort when relaying an error to the main thread. */
export const SW_ERROR_MESSAGE_TYPE = "BOLO_SW_ERROR";
