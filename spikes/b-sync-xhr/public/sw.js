// ServiceWorker for spike (b). Intercepts /b/sync requests (including
// synchronous XHR from workers), forwards the request to the controlled
// window via postMessage, and resolves respondWith when the window replies.
const pending = new Map(); // id -> resolve(Response)
let nextId = 0;

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname !== "/b/sync") {
    e.respondWith(fetch(e.request));
    return;
  }
  const size = Number(url.searchParams.get("size") ?? 16);
  const id = ++nextId;
  e.respondWith(
    new Promise((resolve) => {
      pending.set(id, resolve);
      clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((wins) => wins.forEach((w) => w.postMessage({ type: "b-sync", id, size })));
      setTimeout(() => {
        if (pending.delete(id)) resolve(new Response("TIMEOUT:" + id));
      }, 3000);
    }),
  );
});

self.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.type === "b-reply" && pending.has(m.id)) {
    const resolve = pending.get(m.id);
    pending.delete(m.id);
    resolve(new Response(m.body, { headers: { "Content-Type": "text/plain" } }));
  }
});
