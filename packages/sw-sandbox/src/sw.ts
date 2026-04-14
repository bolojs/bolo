const pendingRequests = new Map<number, { req: Request; port: MessagePort }>();
let mainPort: MessagePort | null = null;

interface SWGlobal {
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(
    type: 'activate',
    listener: (event: { waitUntil(p: Promise<void>): void }) => void,
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: { data?: { type: string }; ports?: MessagePort[]; source?: { postMessage(message: unknown): void } }) => void,
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

  swGlobal.addEventListener('message', (event) => {
    if (event.data?.type === 'INIT_PORT' && event.ports?.[0]) {
      mainPort = event.ports[0];
      mainPort.onmessage = (e: MessageEvent) => {
        const { requestId, request } = e.data as {
          requestId: number;
          request: { url: string; method: string; headers: Record<string, string>; body?: string };
        };
        const req = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        handleFetch(requestId, req, mainPort!);
      };
      // Send SW_READY back to the client so pages that load after the SW is
      // already active (and therefore missed the activate-time broadcast) can
      // still complete initialization.
      event.source?.postMessage({ type: 'SW_READY' });
    }
  });
}

export function handleFetch(requestId: number, req: Request, port: MessagePort): void {
  pendingRequests.set(requestId, { req, port });
  port.postMessage({ requestId, response: { status: 200, body: 'OK', headers: {} } });
}
