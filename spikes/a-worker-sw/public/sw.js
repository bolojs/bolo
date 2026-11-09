// ServiceWorker for spike (a). Records every fetch event under /a/ with the
// resolved client type, then passes the request through to the network.
// /a/__swlog returns the recorded log and is not itself logged.
const log = [];

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === "/a/__swlog") {
    e.respondWith(Response.json(log));
    return;
  }
  if (url.searchParams.get("synth")) {
    log.push({
      url: url.pathname + url.search,
      dest: e.request.destination,
      clientId: e.clientId,
      client: "synthetic",
    });
    e.respondWith(
      new Response("globalThis.__syntheticDep = true;", {
        headers: { "Content-Type": "text/javascript" },
      }),
    );
    return;
  }
  if (url.searchParams.get("pt")) {
    log.push({
      url: url.pathname + url.search,
      dest: e.request.destination,
      clientId: e.clientId,
      client: "passthrough",
    });
    e.respondWith(fetch(e.request));
    return;
  }
  const entry = {
    url: url.pathname + url.search,
    dest: e.request.destination,
    clientId: e.clientId,
    client: null,
  };
  // Log synchronously: a hung clients.get() must not hide that the fetch
  // event fired.
  log.push(entry);
  e.respondWith(
    (async () => {
      try {
        const c = e.clientId ? await clients.get(e.clientId) : undefined;
        entry.client = c ? c.type : "unresolved";
      } catch (err) {
        entry.client = "err:" + err.message;
      }
      return fetch(e.request);
    })(),
  );
});
