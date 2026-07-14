// Service worker for the bolo demo.
// Implements the SWSandbox protocol from @bolojs/sw-sandbox.

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
  // Intercept the vite preview prefix AND the virtual sandbox hostname
  // (cross-origin user servers like Hono/Express).
  if (!url.pathname.startsWith('/__preview/') && url.hostname !== 'sandbox.local') {
    return;
  }
  if (!isReady || !mainPort) {
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
  event.respondWith(handleFetchEvent(event.request));
});

async function handleFetchEvent(req) {
  if (!mainPort) {
    return new Response('ServiceWorker not ready', { status: 503 });
  }
  const requestId = ++requestIdCounter;
  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await req.text().catch(() => undefined);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    mainPort.postMessage({
      type: 'FETCH_REQUEST',
      requestId,
      request: { url: req.url, method: req.method, headers, body },
    });
  });
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'INIT_PORT' && event.ports?.[0]) {
    mainPort = event.ports[0];
    mainPort.onmessage = (e) => {
      const { type, requestId, response, error } = e.data;
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
