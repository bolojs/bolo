const pendingRequests = new Map<
  number,
  {
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }
>();
let mainPort: MessagePort | null = null;
let requestIdCounter = 0;
let isReady = false;
const requestQueue: Array<() => void> = [];
const SW_ERROR_MESSAGE_TYPE = "BOLO_SW_ERROR";

interface SWGlobal {
  addEventListener(type: "install", listener: () => void): void;
  addEventListener(
    type: "activate",
    listener: (event: { waitUntil(p: Promise<void>): void }) => void,
  ): void;
  addEventListener(
    type: "fetch",
    listener: (event: {
      request: Request;
      respondWith(p: Promise<Response> | Response): void;
    }) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data?: { type: string }; ports?: MessagePort[] }) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { message?: string; error?: unknown }) => void,
  ): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: { reason?: unknown }) => void,
  ): void;
  skipWaiting(): void;
  clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: "window";
    }): Promise<ReadonlyArray<{ postMessage(message: unknown): void }>>;
  };
}

export function initSW(swGlobal: SWGlobal): void {
  swGlobal.addEventListener("install", () => {
    swGlobal.skipWaiting();
  });

  swGlobal.addEventListener("activate", (event) => {
    event.waitUntil(swGlobal.clients.claim());
    swGlobal.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "SW_READY" });
      }
    });
  });

  swGlobal.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    // Intercept the vite preview prefix (same origin) AND the virtual sandbox
    // hostname (cross-origin user servers like Hono/Express).
    if (
      !url.pathname.startsWith("/__preview/") &&
      !url.pathname.startsWith("/__virtual__/") &&
      url.hostname !== "sandbox.local"
    ) {
      return;
    }
    if (!isReady || !mainPort) {
      event.respondWith(
        new Promise<Response>((resolve, reject) => {
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

  swGlobal.addEventListener("message", (event) => {
    if (event.data?.type === "INIT_PORT" && event.ports?.[0]) {
      mainPort = event.ports[0];
      mainPort.onmessage = (e: MessageEvent) => {
        const { type, requestId, response, error } = e.data as {
          type?: string;
          requestId: number;
          response?: { status: number; body: ArrayBuffer; headers: Record<string, string> };
          error?: string;
        };
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
        }
      };
      isReady = true;
      mainPort.postMessage({ type: "PORT_READY" });
      while (requestQueue.length > 0) {
        const fn = requestQueue.shift();
        fn?.();
      }
    }
  });

  // Forward SW-global errors to the main thread so they show up in
  // window.__boloObsDrain() — without this, SW errors are invisible
  // from the page (the DevTools SW console is the only way to see them).
  const postSWError = (kind: "error" | "unhandledrejection", payload: unknown): void => {
    mainPort?.postMessage({
      type: SW_ERROR_MESSAGE_TYPE,
      error: {
        kind: "sw",
        source: "sw",
        message: `${kind}: ${payload instanceof Error ? payload.message : String(payload)}`,
        stack: payload instanceof Error ? payload.stack : undefined,
        ts: Date.now(),
      },
    });
  };
  swGlobal.addEventListener("error", (event) => {
    postSWError("error", event.error ?? event.message ?? "unknown");
  });
  swGlobal.addEventListener("unhandledrejection", (event) => {
    postSWError("unhandledrejection", event.reason);
  });
}

async function handleFetchEvent(req: Request): Promise<Response> {
  if (!mainPort) {
    return new Response("ServiceWorker not ready", { status: 503 });
  }
  const requestId = ++requestIdCounter;
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await req.arrayBuffer().catch(() => undefined);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    mainPort!.postMessage(
      {
        type: "FETCH_REQUEST",
        requestId,
        request: { url: req.url, method: req.method, headers, body },
      },
      body ? [body] : [],
    );
  });
}
