// Service worker for the bolo compat harness.
//
// Implements the SWSandbox protocol from @bolojs/sandbox, mirroring
// packages/sw-sandbox/src/sw.ts (the canonical implementation). It is checked
// in as a plain script because a ServiceWorker script must be served as
// JavaScript at a stable URL: without this file the runtime's default
// swPath ("/sw.js") 404s into the dev server's HTML fallback, which the
// browser rejects with "The script has an unsupported MIME type ('text/html')"
// and the container then runs without a sandbox at all.
//
// Regenerate from packages/sw-sandbox/src/sw.ts when that file changes.

const pendingRequests = new Map();
let mainPort = null;
let requestIdCounter = 0;
let isReady = false;
const requestQueue = [];
const SW_ERROR_MESSAGE_TYPE = "BOLO_SW_ERROR";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
  self.clients.matchAll({ type: "window" }).then((clients) => {
    for (const client of clients) {
      client.postMessage({ type: "SW_READY" });
    }
  });
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Intercept the vite preview prefix, the virtual container ports and the
  // virtual sandbox hostname (cross-origin user servers like Hono/Express).
  if (
    !url.pathname.startsWith("/__preview/") &&
    !url.pathname.startsWith("/__virtual__/") &&
    url.hostname !== "sandbox.local"
  ) {
    return;
  }
  if (!isReady || !mainPort) {
    event.respondWith(
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Response("ServiceWorker timeout", { status: 503 }));
        }, 5000);
        requestQueue.push(() => {
          clearTimeout(timeout);
          handleFetchEvent(event.request).then(resolve, reject);
        });
      }),
    );
    return;
  }
  event.respondWith(handleFetchEvent(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "INIT_PORT" && event.ports?.[0]) {
    mainPort = event.ports[0];
    mainPort.onmessage = (e) => {
      const { type, requestId, response, error } = e.data;
      if (type === "FETCH_RESPONSE") {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        if (error) {
          pending.reject(new Error(error));
        } else if (response) {
          pending.resolve(
            new Response(response.body, { status: response.status, headers: response.headers }),
          );
        } else {
          pending.reject(new Error("Invalid response"));
        }
        return;
      }
    };
    isReady = true;
    if (mainPort) {
      mainPort.postMessage({ type: "PORT_READY" });
    }
    while (requestQueue.length > 0) {
      const fn = requestQueue.shift();
      fn?.();
    }
  }
});

// Forward SW-global errors to the main thread so they surface in the
// container's diagnostics instead of only in the DevTools SW console.
const postSWError = (kind, payload) => {
  mainPort?.postMessage({
    type: SW_ERROR_MESSAGE_TYPE,
    error: {
      kind: kind,
      source: "sw",
      message: `${kind}: ${payload instanceof Error ? payload.message : String(payload)}`,
      stack: payload instanceof Error ? payload.stack : undefined,
      ts: Date.now(),
    },
  });
};
self.addEventListener("error", (event) => {
  postSWError("error", event.error ?? event.message ?? "unknown");
});
self.addEventListener("unhandledrejection", (event) => {
  postSWError("unhandledrejection", event.reason);
});

async function handleFetchEvent(req) {
  if (!mainPort) {
    return new Response("ServiceWorker not ready", { status: 503 });
  }
  const requestId = ++requestIdCounter;
  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await req.arrayBuffer().catch(() => undefined);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    mainPort.postMessage(
      {
        type: "FETCH_REQUEST",
        requestId,
        request: { url: req.url, method: req.method, headers, body },
      },
      body ? [body] : [],
    );
  });
}
