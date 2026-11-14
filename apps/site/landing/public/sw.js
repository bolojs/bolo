// Service worker for the bolo demo.
// Implements the SWSandbox protocol from @bolojs/sandbox.

const pendingRequests = new Map();
let mainPort = null;
let requestIdCounter = 0;
let isReady = false;
const requestQueue = [];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'SW_READY' });
        }
      })
    )
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSync = url.pathname.includes('/__bolo_sync/');
  // Intercept the vite preview prefix, the Next.js dev server prefix, the
  // virtual sandbox hostname (cross-origin user servers like Hono/Express)
  // and the sync channel prefix used by process workers for synchronous
  // syscalls.
  if (
    !isSync &&
    !url.pathname.startsWith('/__preview/') &&
    !url.pathname.startsWith('/__next/') &&
    url.hostname !== 'sandbox.local'
  ) {
    return;
  }
  if (!isReady || !mainPort) {
    // A sync XHR cannot wait for the port handshake — fail fast.
    if (isSync) {
      event.respondWith(new Response('Sync channel not ready', { status: 503 }));
      return;
    }
    event.respondWith(
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Response('ServiceWorker timeout', { status: 503 }));
        }, 5000);
        requestQueue.push(() => {
          clearTimeout(timeout);
          handleFetchEvent(event.request).then(resolve, reject);
        });
      })
    );
    return;
  }
  event.respondWith(handleFetchEvent(event.request, isSync));
});

async function handleFetchEvent(req, isSync = false) {
  if (!mainPort) {
    return new Response('ServiceWorker not ready', { status: 503 });
  }
  const requestId = ++requestIdCounter;
  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // Sync payloads are raw bytes; preview fetches stay text for compatibility.
  const body = isSync
    ? await req.arrayBuffer().catch(() => undefined)
    : await req.text().catch(() => undefined);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    mainPort.postMessage(
      {
        type: isSync ? 'SYNC_REQUEST' : 'FETCH_REQUEST',
        requestId,
        request: { url: req.url, method: req.method, headers, body },
      },
      body instanceof ArrayBuffer ? [body] : [],
    );
  });
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'INIT_PORT' && event.ports?.[0]) {
    mainPort = event.ports[0];
    mainPort.onmessage = (e) => {
      const { type, requestId, response, error } = e.data;
      if (type === 'FETCH_RESPONSE' || type === 'SYNC_RESPONSE') {
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
        return;
      }
    };
    isReady = true;
    if (mainPort) {
      mainPort.postMessage({ type: 'PORT_READY' });
    }
    while (requestQueue.length > 0) {
      const fn = requestQueue.shift();
      fn?.();
    }
  }
});
