import type { SWSandbox } from '@browser-containers/sw-sandbox';
import { createEventsShim } from '@browser-containers/node-web-shims';

const { EventEmitter } = createEventsShim();

export interface HttpShimOptions {
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
}

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

        const url = new URL(req.url);
        const request: IncomingMessage = {
          url: url.pathname + url.search,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
        };

        const chunks: Uint8Array[] = [];
        let status = 200;
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' };

        const response: ServerResponse = {
          writeHead: (s: number, h?: Record<string, string>) => {
            status = s;
            if (h) Object.assign(headers, h);
          },
          write: (chunk: Uint8Array | string) => {
            chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          },
          end: (chunk?: Uint8Array | string) => {
            if (chunk) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
          },
        };

        if (handler) {
          await handler(request, response);
        }

        const body = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return new Response(body, { status, headers });
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

export interface IncomingMessage {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface ServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  write(chunk: Uint8Array | string): void;
  end(chunk?: Uint8Array | string): void;
}

export interface Server {
  listen(port?: number, host?: string, callback?: () => void): Server;
  close(): Server;
  on(event: string, listener: (...args: any[]) => void): Server;
}

export const createNetShim = (sandbox: SWSandbox, options?: HttpShimOptions) => {
  return createHttpShim(sandbox, options);
};
