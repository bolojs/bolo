import { getLogger } from "@bolojs/log/browser";

const logger = getLogger(["bolo", "sw-sandbox"]);

export type FetchHandler = (req: Request) => Promise<Response>;

/** A synchronous syscall from a process worker, relayed by the SW (sync XHR)
 * or served via SharedArrayBuffer. `url` carries the `__bolo_sync/<pid>` path;
 * `body` is the raw request payload. The handler returns raw response bytes. */
export interface SyncRequest {
  url: string;
  method: string;
  body?: ArrayBuffer;
}

export interface SyncResponse {
  status?: number;
  body: ArrayBuffer;
}

export type SyncHandler = (
  req: SyncRequest,
) => Promise<SyncResponse | undefined> | SyncResponse | undefined;

/**
 * Bound on the INIT_PORT → PORT_READY handshake. A SW that registered but
 * never answers (wedged on install, killed by the browser) would otherwise
 * leave `init()` pending forever — and every caller of `SWSandbox.create`
 * hanging with it. Fifteen seconds is generous for a same-origin handshake.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;

export class SWSandbox {
  private origin: string;
  private swPath: string;
  private fetchHandlers: FetchHandler[] = [];
  private syncHandlers: SyncHandler[] = [];
  private policyRegistry?: Map<string, unknown>;
  private messagePort?: MessagePort;
  private pendingRequests = new Map<
    number,
    { resolve: (r: Response) => void; reject: (e: Error) => void }
  >();

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
    if (typeof navigator === "undefined" || !navigator.serviceWorker) {
      throw new Error("ServiceWorker not supported");
    }
    // Scope defaults to the directory the SW lives in. For "/sw.js" the
    // derived scope is "/" — same as today; for "/demo/sw.js" it becomes
    // "/demo/" — required when mounted under a sub-path.
    const scope = this.swPath.slice(0, this.swPath.lastIndexOf("/") + 1);
    await navigator.serviceWorker.register(this.swPath, { scope });
    const registration = await navigator.serviceWorker.ready;

    const channel = new MessageChannel();
    this.messagePort = channel.port1;

    const portReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messagePort!.removeEventListener("message", onPortMessage);
        reject(
          new Error(
            `SWSandbox: service worker did not answer INIT_PORT within ${HANDSHAKE_TIMEOUT_MS}ms`,
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);
      const onPortMessage = (event: MessageEvent) => {
        if (event.data?.type === "PORT_READY") {
          clearTimeout(timer);
          this.messagePort!.removeEventListener("message", onPortMessage);
          resolve();
        }
      };
      this.messagePort!.addEventListener("message", onPortMessage);
    });

    this.messagePort.onmessage = (event: MessageEvent) => {
      const { type, requestId, response, error, request } = event.data as {
        type?: string;
        requestId: number;
        response?: { status: number; body: ArrayBuffer; headers: Record<string, string> };
        error?: string;
        request?: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body?: ArrayBuffer;
        };
        // SW_ERROR shape: { type: "BOLO_SW_ERROR", error: BoloError }.
        swError?: {
          kind: string;
          source: string;
          message: string;
          stack?: string;
          ts: number;
        };
      };
      if (type === "BOLO_SW_ERROR" && event.data && (event.data as { swError?: unknown }).swError) {
        const err = (
          event.data as {
            swError: { kind: string; source: string; message: string; stack?: string; ts: number };
          }
        ).swError;
        // Push into the main-thread obs buffer installed by bolojs's
        // installMainRelay(). Cross-package bridge via globalThis avoids a
        // runtime -> sw-sandbox dep inversion.
        const push = (globalThis as { __boloObsPush?: (r: unknown) => void }).__boloObsPush;
        push?.(err);
        return;
      }
      if (type === "FETCH_REQUEST" && request) {
        this.handleFetchRequest(requestId, request).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("handleFetchRequest failed", { error: message });
          this.messagePort?.postMessage({
            type: "FETCH_RESPONSE",
            requestId,
            error: message,
          });
        });
        return;
      }
      if (type === "SYNC_REQUEST" && request) {
        this.handleSyncRequest(requestId, request).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("handleSyncRequest failed", { error: message });
          this.messagePort?.postMessage({ type: "SYNC_RESPONSE", requestId, error: message });
        });
        return;
      }
      const pending = this.pendingRequests.get(requestId);
      if (!pending) return;
      this.pendingRequests.delete(requestId);
      if (error) {
        pending.reject(new Error(error));
      } else if (response) {
        pending.resolve(
          new Response(response.body, { status: response.status, headers: response.headers }),
        );
      }
    };

    const sw = registration.active || registration.installing || registration.waiting;
    if (sw) {
      sw.postMessage({ type: "INIT_PORT" }, [channel.port2]);
    }

    await portReady;
  }

  onFetch(handler: FetchHandler): void {
    this.fetchHandlers.push(handler);
  }

  /** Register a handler for synchronous syscalls arriving over `/__bolo_sync/`.
   * Handlers are tried in registration order; the first to return wins. */
  onSyncRequest(handler: SyncHandler): void {
    this.syncHandlers.push(handler);
  }

  /** Scope the SW controls (directory of `swPath`), e.g. "/" or "/demo/". */
  get scope(): string {
    return this.swPath.slice(0, this.swPath.lastIndexOf("/") + 1);
  }

  private async handleSyncRequest(
    requestId: number,
    requestData: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: ArrayBuffer;
    },
  ): Promise<void> {
    for (const handler of this.syncHandlers) {
      try {
        const result = await handler({
          url: requestData.url,
          method: requestData.method,
          body: requestData.body,
        });
        if (!result) continue;
        this.messagePort?.postMessage(
          {
            type: "SYNC_RESPONSE",
            requestId,
            response: { status: result.status ?? 200, body: result.body, headers: {} },
          },
          [result.body],
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.messagePort?.postMessage({ type: "SYNC_RESPONSE", requestId, error: message });
        return;
      }
    }
    this.messagePort?.postMessage({
      type: "SYNC_RESPONSE",
      requestId,
      error: "no sync handler registered",
    });
  }

  setPolicyRegistry(registry: Map<string, unknown>): void {
    this.policyRegistry = registry;
  }

  private async handleFetchRequest(
    requestId: number,
    requestData: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: ArrayBuffer;
    },
  ): Promise<void> {
    const requestBody =
      requestData.body && requestData.method !== "GET" && requestData.method !== "HEAD"
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
        type: "FETCH_RESPONSE",
        requestId,
        response: { status: response.status, body, headers },
      },
      [body],
    );
  }

  async handleInterceptedRequest(requestId: number, req: Request): Promise<Response> {
    for (const handler of this.fetchHandlers) {
      const url = new URL(req.url);
      if (
        url.origin === this.origin ||
        url.hostname === "localhost" ||
        url.hostname === "sandbox.local"
      ) {
        try {
          const response = await handler(req);
          // sandbox.local is cross-origin from the demo page — needs CORS to be readable.
          if (url.hostname === "sandbox.local") {
            const headers = new Headers(response.headers);
            headers.set("Access-Control-Allow-Origin", "*");
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
    return new Response("Not found", { status: 404 });
  }
}
