import type { SWSandbox } from '@browser-containers/sw-sandbox';
import { createEventsShim, createStreamShim, createBufferShim } from '@browser-containers/node-web-shims';

const { EventEmitter } = createEventsShim();
const { Readable, Writable } = createStreamShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (a pre-existing
// tsc declaration-emit quirk on unenv's untyped default export), so read it off the
// runtime value instead of trusting the type.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

export interface HttpShimOptions {
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
}

const toBytes = (chunk: unknown): Uint8Array =>
  typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);

const lowerCaseHeaders = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
};

/**
 * unenv's own `Readable` doesn't implement flowing-mode delivery (`push`
 * is a no-op), so it's overridden here to actually emit data. The SW hands
 * over a fully-buffered request body (never a chunked stream — see the
 * binary-safe MessagePort work), so the whole thing is emitted as one
 * 'data' + 'end' pair on the next microtask, after the request handler's
 * synchronous setup (where body-parsing middleware attaches its listeners,
 * e.g. Express's body-parser) has had a chance to run.
 */
class IncomingMessageImpl extends Readable {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly httpVersion = '1.1';
  complete = false;

  constructor(url: string, method: string, headers: Record<string, string>, body: Uint8Array) {
    super();
    this.url = url;
    this.method = method;
    this.headers = headers;
    queueMicrotask(() => {
      if (body.byteLength > 0) this.emit('data', Buffer.from(body));
      this.complete = true;
      this.emit('end');
    });
  }

  override read(): unknown {
    return null;
  }
}

/**
 * unenv's own `Writable` already buffers written chunks and emits
 * 'finish'/'close' from `end()`, so only the http-specific surface
 * (writeHead/setHeader/statusCode/headersSent) plus the chunk capture
 * needed to build the final `Response` are added here.
 */
class ServerResponseImpl extends Writable {
  statusCode = 200;
  headersSent = false;
  private responseHeaders: Record<string, string> = { 'content-type': 'text/plain' };
  private chunks: Uint8Array[] = [];

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.responseHeaders, lowerCaseHeaders(headers));
    this.headersSent = true;
    return this;
  }

  setHeader(key: string, value: string): this {
    this.responseHeaders[key.toLowerCase()] = String(value);
    return this;
  }

  getHeader(key: string): string | undefined {
    return this.responseHeaders[key.toLowerCase()];
  }

  removeHeader(key: string): void {
    delete this.responseHeaders[key.toLowerCase()];
  }

  override _write(chunk: unknown, _encoding: string, callback?: (error?: Error | null) => void): void {
    this.headersSent = true;
    this.chunks.push(toBytes(chunk));
    callback?.();
  }

  toResponse(): Response {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, { status: this.statusCode, headers: this.responseHeaders });
  }
}

export type IncomingMessage = IncomingMessageImpl;
export type ServerResponse = ServerResponseImpl;

export const createHttpShim = (sandbox: SWSandbox, options?: HttpShimOptions) => {
  const { onPortEvent } = options ?? {};

  const createServer = (handler?: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = new EventEmitter() as unknown as Server;
    let listening = false;
    let serverPort = 0;

    server.listen = (port?: number, host?: string, callback?: () => void) => {
      const actualPort = port ?? 3000;
      const url = `http://localhost:${actualPort}`;

      listening = true;
      serverPort = actualPort;

      onPortEvent?.('server-ready', { port: actualPort, url });
      onPortEvent?.('port-open', { port: actualPort, url });

      const fetchHandler = async (req: Request) => {
        if (!listening) {
          return new Response('Server closed', { status: 503 });
        }

        const reqUrl = new URL(req.url);
        const body = req.body ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
        const request = new IncomingMessageImpl(
          reqUrl.pathname + reqUrl.search,
          req.method,
          lowerCaseHeaders(Object.fromEntries(req.headers.entries())),
          body,
        );
        const response = new ServerResponseImpl();

        // Real completion is always signaled by `res.end()` — possibly after
        // async body-parsing middleware has consumed `request`'s 'data'/'end'
        // events — not by the handler function itself returning, which most
        // http frameworks (Express, plain `http.createServer`) never await.
        const responseFinished = new Promise<void>((resolve) => {
          response.once('finish', () => resolve());
        });

        const result = handler?.(request, response);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          await result;
        }
        await responseFinished;

        return response.toResponse();
      };

      sandbox.onFetch(fetchHandler);

      if (callback) callback();
      return server;
    };

    server.close = () => {
      if (listening) {
        onPortEvent?.('port-close', { port: serverPort });
        listening = false;
      }
      return server;
    };

    return server;
  };

  return { createServer };
};

export interface Server {
  listen(port?: number, host?: string, callback?: () => void): Server;
  close(): Server;
  on(event: string, listener: (...args: any[]) => void): Server;
}

export const createNetShim = (sandbox: SWSandbox, options?: HttpShimOptions) => {
  return createHttpShim(sandbox, options);
};
