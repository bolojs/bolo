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

interface SWGlobal {
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(
    type: 'activate',
    listener: (event: { waitUntil(p: Promise<void>): void }) => void,
  ): void;
  addEventListener(
    type: 'fetch',
    listener: (event: {
      request: Request;
      respondWith(p: Promise<Response> | Response): void;
    }) => void,
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: { data?: { type: string }; ports?: MessagePort[] }) => void,
  ): void;
  skipWaiting(): void;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window' }): Promise<ReadonlyArray<{ postMessage(message: unknown): void }>>;
  };
}

export function initSW(swGlobal: SWGlobal): void {
  swGlobal.addEventListener('install', () => {
    swGlobal.skipWaiting();
  });

  swGlobal.addEventListener('activate', (event) => {
    event.waitUntil(swGlobal.clients.claim());
    swGlobal.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: 'SW_READY' });
      }
    });
  });

  swGlobal.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith('/__preview/')) {
      return;
    }
    if (!isReady || !mainPort) {
      event.respondWith(
        new Promise<Response>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Response('ServiceWorker timeout', { status: 503 }));
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

  swGlobal.addEventListener('message', (event) => {
    if (event.data?.type === 'INIT_PORT' && event.ports?.[0]) {
      mainPort = event.ports[0];
      mainPort.onmessage = (e: MessageEvent) => {
        const { type, requestId, response, error } = e.data as {
          type?: string;
          requestId: number;
          response?: { status: number; body: string; headers: Record<string, string> };
          error?: string;
        };
        if (type === 'FETCH_RESPONSE') {
          const pending = pendingRequests.get(requestId);
          if (!pending) return;
          pendingRequests.delete(requestId);
          if (error) {
            pending.reject(new Error(error));
          } else if (response) {
            pending.resolve(new Response(response.body, { status: response.status, headers: response.headers }));
          } else {
            pending.reject(new Error('Invalid response'));
          }
        }
      };
      isReady = true;
      while (requestQueue.length > 0) {
        const fn = requestQueue.shift();
        fn?.();
      }
    }
  });
}

async function handleFetchEvent(req: Request): Promise<Response> {
  if (!mainPort) {
    return new Response('ServiceWorker not ready', { status: 503 });
  }
  const requestId = ++requestIdCounter;
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await req.text().catch(() => undefined);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    mainPort!.postMessage({
      type: 'FETCH_REQUEST',
      requestId,
      request: { url: req.url, method: req.method, headers, body },
    });
  });
}
