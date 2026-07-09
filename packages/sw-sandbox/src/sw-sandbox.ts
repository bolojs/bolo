export type FetchHandler = (req: Request) => Promise<Response>;

export class SWSandbox {
  private origin: string;
  private swPath: string;
  private fetchHandlers: FetchHandler[] = [];
  private policyRegistry?: Map<string, unknown>;
  private messagePort?: MessagePort;
  private pendingRequests = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

  static async create(opts: { origin: string; swPath: string }): Promise<SWSandbox> {
    const instance = new SWSandbox(opts.origin, opts.swPath);
    await instance.init();
    return instance;
  }

  private constructor(origin: string, swPath: string) {
    this.origin = origin;
    this.swPath = swPath;
  }

  private async init(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      throw new Error('ServiceWorker not supported');
    }
    await navigator.serviceWorker.register(this.swPath);
    const registration = await navigator.serviceWorker.ready;

    const channel = new MessageChannel();
    this.messagePort = channel.port1;

    const portReady = new Promise<void>((resolve) => {
      const onPortMessage = (event: MessageEvent) => {
        if (event.data?.type === 'PORT_READY') {
          this.messagePort!.removeEventListener('message', onPortMessage);
          resolve();
        }
      };
      this.messagePort!.addEventListener('message', onPortMessage);
    });

    this.messagePort.onmessage = (event: MessageEvent) => {
      const { type, requestId, response, error, request } = event.data as {
        type?: string;
        requestId: number;
        response?: { status: number; body: ArrayBuffer; headers: Record<string, string> };
        error?: string;
        request?: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer };
      };
      if (type === 'FETCH_REQUEST' && request) {
        this.handleFetchRequest(requestId, request).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[sw-sandbox] handleFetchRequest failed:', message);
          this.messagePort?.postMessage({
            type: 'FETCH_RESPONSE',
            requestId,
            error: message,
          });
        });
        return;
      }
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;
      this.pendingRequests.delete(requestId);
      if (error) {
        pending.reject(new Error(error));
      } else if (response) {
        pending.resolve(new Response(response.body, { status: response.status, headers: response.headers }));
      }
    };


    const sw = registration.active || registration.installing || registration.waiting;
    if (sw) {
      sw.postMessage({ type: 'INIT_PORT' }, [channel.port2]);
    }

    await portReady;
  }

  onFetch(handler: FetchHandler): void {
    this.fetchHandlers.push(handler);
  }

  setPolicyRegistry(registry: Map<string, unknown>): void {
    this.policyRegistry = registry;
  }

  private async handleFetchRequest(
    requestId: number,
    requestData: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer },
  ): Promise<void> {
    const requestBody =
      requestData.body && requestData.method !== 'GET' && requestData.method !== 'HEAD'
        ? requestData.body
        : undefined;
    const request = new Request(requestData.url, {
      method: requestData.method,
      headers: requestData.headers,
      body: requestBody,
    });
    const response = await this.handleInterceptedRequest(requestId, request);
    const body = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    this.messagePort?.postMessage(
      {
        type: 'FETCH_RESPONSE',
        requestId,
        response: { status: response.status, body, headers },
      },
      [body],
    );
  }

  async handleInterceptedRequest(requestId: number, req: Request): Promise<Response> {
    for (const handler of this.fetchHandlers) {
      const url = new URL(req.url);
      if (url.origin === this.origin || url.hostname === 'localhost' || url.hostname === 'sandbox.local') {
        try {
          const response = await handler(req);
          // sandbox.local is cross-origin from the demo page — needs CORS to be readable.
          if (url.hostname === 'sandbox.local') {
            const headers = new Headers(response.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
          return response;
        } catch {
          continue;
        }
      }
    }
    return new Response('Not found', { status: 404 });
  }
}
