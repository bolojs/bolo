import type { NetConnectOptions } from "./live.js";
import type { SWSandbox } from "@bolojs/sw-sandbox";
import { createEventsShim, createStreamShim, createBufferShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();
const { Readable, Writable } = createStreamShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (a pre-existing
// tsc declaration-emit quirk on unenv's untyped default export), so read it off the
// runtime value instead of trusting the type.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

export interface HttpShimOptions {
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
}

export interface RequestOptions {
  method?: string;
  protocol?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  headers?: Record<string, string | string[]> | [string, string][] | Headers;
  auth?: string;
  agent?: Agent | boolean | null;
  timeout?: number;
  signal?: AbortSignal;
}

const toBytes = (chunk: unknown): Uint8Array =>
  typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);

const lowerCaseHeaders = (headers: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
};

const normalizeHeaders = (headers?: RequestOptions["headers"]): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
};

const buildRequestUrl = (
  urlOrOpts: string | URL | RequestOptions,
  options?: RequestOptions,
): URL => {
  if (typeof urlOrOpts === "string") urlOrOpts = new URL(urlOrOpts);
  if (urlOrOpts instanceof URL) {
    const url = new URL(urlOrOpts.href);
    if (options?.path) url.pathname = options.path;
    return url;
  }
  const opts = urlOrOpts;
  const protocol = `${(opts.protocol ?? "http:").replace(/:$/, "")}:`;
  const hostname = opts.hostname ?? opts.host ?? "localhost";
  const port = opts.port ? `:${opts.port}` : "";
  const path = opts.path ?? "/";
  return new URL(`${protocol}//${hostname}${port}${path}`);
};

const normalizeRequestOptions = (
  urlOrOpts: string | URL | RequestOptions,
  options?: RequestOptions,
): { url: URL; method: string; headers: Record<string, string>; timeout?: number } => {
  const opts =
    typeof urlOrOpts === "string" || urlOrOpts instanceof URL ? (options ?? {}) : urlOrOpts;
  const url = buildRequestUrl(urlOrOpts, options);
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(opts.headers);
  if (opts.auth && !headers.authorization) {
    headers.authorization = `Basic ${Buffer.from(opts.auth).toString("base64")}`;
  }
  return { url, method, headers, timeout: opts.timeout };
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
  readonly url?: string;
  readonly method?: string;
  readonly headers: Record<string, string>;
  readonly httpVersion = "1.1";
  readonly statusCode?: number;
  readonly statusMessage?: string;
  complete = false;
  private body?: Uint8Array;
  private emitted = false;

  constructor(init: {
    url?: string;
    method?: string;
    headers: Record<string, string>;
    body?: Uint8Array;
    statusCode?: number;
    statusMessage?: string;
    autoEmit?: boolean;
  }) {
    super();
    this.url = init.url;
    this.method = init.method;
    this.headers = init.headers;
    this.statusCode = init.statusCode;
    this.statusMessage = init.statusMessage;
    this.body = init.body;
    if (init.autoEmit !== false) {
      queueMicrotask(() => this._emitBody());
    }
  }

  emitBody(): void {
    queueMicrotask(() => this._emitBody());
  }

  private _emitBody(): void {
    if (this.emitted) return;
    this.emitted = true;
    const body = this.body ?? new Uint8Array(0);
    if (body.byteLength > 0) this.emit("data", Buffer.from(body));
    this.complete = true;
    this.emit("end");
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
  private responseHeaders: Record<string, string> = { "content-type": "text/plain" };
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

  override _write(
    chunk: unknown,
    _encoding: string,
    callback?: (error?: Error | null) => void,
  ): void {
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

class ClientRequestImpl extends EventEmitter {
  readonly url: URL;
  readonly method: string;
  private readonly headers: Record<string, string>;
  private readonly chunks: Uint8Array[] = [];
  private readonly abortController: AbortController;
  private readonly detachAgent?: () => void;
  private detached = false;
  private response: IncomingMessageImpl | null = null;
  private finished = false;
  private aborted = false;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    urlOrOpts: string | URL | RequestOptions,
    options?: RequestOptions | ((res: IncomingMessageImpl) => void),
    callback?: (res: IncomingMessageImpl) => void,
  ) {
    super();
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    const { url, method, headers, timeout } = normalizeRequestOptions(
      urlOrOpts,
      options as RequestOptions | undefined,
    );
    this.url = url;
    this.method = method;
    this.headers = headers;
    const opts =
      typeof urlOrOpts === "string" || urlOrOpts instanceof URL
        ? (options as RequestOptions | undefined)
        : (urlOrOpts as RequestOptions);
    const agent = opts?.agent;
    if (agent === false || agent === null || agent === undefined) {
      this.abortController = new AbortController();
    } else {
      const origin = `${this.url.protocol}//${this.url.host}`;
      const connection = (agent as Agent).get(origin);
      this.abortController = connection.controller;
      this.detachAgent = connection.detach;
    }
    if (callback) this.on("response", callback);
    if (timeout) this.setTimeout(timeout);
  }

  write(
    chunk: unknown,
    encoding?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    this.chunks.push(toBytes(chunk));
    callback?.();
    return true;
  }

  end(chunk?: unknown, encoding?: string | (() => void), callback?: () => void): this {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk !== undefined) this.write(chunk);
    this.finished = true;
    if (callback) this.once("finish", callback);
    this._send();
    return this;
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.detachAgent?.();
  }

  private async _send(): Promise<void> {
    if (this.aborted) return;
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const body = length > 0 ? new Uint8Array(length) : undefined;
    if (body) {
      let offset = 0;
      for (const chunk of this.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const init: RequestInit = {
      method: this.method,
      headers: this.headers,
      signal: this.abortController.signal,
    };
    if (body) init.body = body;

    try {
      const res = await globalThis.fetch(this.url, init);
      if (this.timeoutId) clearTimeout(this.timeoutId);
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const responseBody = new Uint8Array(await res.arrayBuffer());
      this.response = new IncomingMessageImpl({
        headers: responseHeaders,
        body: responseBody,
        statusCode: res.status,
        statusMessage: res.statusText,
        autoEmit: false,
      });
      this.emit("response", this.response);
      this.response.emitBody();
      this.emit("finish");
    } catch (err) {
      if (this.timeoutId) clearTimeout(this.timeoutId);
      if (!this.aborted) this.emit("error", err);
    } finally {
      this.detach();
    }
  }

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  setTimeout(ms: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    this.timeoutId = setTimeout(() => {
      this.abortController.abort();
      this.emit("timeout");
    }, ms);
    return this;
  }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
    this.detach();
    this.emit("abort");
  }

  destroy(error?: Error): void {
    this.aborted = true;
    this.abortController.abort();
    this.detach();
    if (this.timeoutId) clearTimeout(this.timeoutId);
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

class Agent {
  maxSockets: number;
  maxFreeSockets: number;
  keepAlive: boolean;
  private connections = new Map<string, { controller: AbortController; count: number }>();

  constructor(options?: { maxSockets?: number; maxFreeSockets?: number; keepAlive?: boolean }) {
    this.maxSockets = options?.maxSockets ?? Infinity;
    this.maxFreeSockets = options?.maxFreeSockets ?? 256;
    this.keepAlive = options?.keepAlive ?? false;
  }

  get(origin: string): { controller: AbortController; detach: () => void } {
    const existing = this.connections.get(origin);
    if (existing && existing.count < (this.maxSockets === Infinity ? 6 : this.maxSockets)) {
      existing.count++;
      return { controller: existing.controller, detach: () => existing.count-- };
    }
    const controller = new AbortController();
    this.connections.set(origin, { controller, count: 1 });
    return {
      controller,
      detach: () => {
        const c = this.connections.get(origin);
        if (c) {
          c.count--;
          if (c.count <= 0) this.connections.delete(origin);
        }
      },
    };
  }

  destroy(): void {
    for (const { controller } of this.connections.values()) {
      controller.abort();
    }
    this.connections.clear();
  }
}

const globalAgent = new Agent();

export const createAgent = (options?: ConstructorParameters<typeof Agent>[0]) => new Agent(options);

const request = (
  urlOrOpts: string | URL | RequestOptions,
  options?: RequestOptions | ((res: IncomingMessageImpl) => void),
  callback?: (res: IncomingMessageImpl) => void,
): ClientRequestImpl => {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  return new ClientRequestImpl(urlOrOpts, options as RequestOptions | undefined, callback);
};

const get = (
  urlOrOpts: string | URL | RequestOptions,
  options?: RequestOptions | ((res: IncomingMessageImpl) => void),
  callback?: (res: IncomingMessageImpl) => void,
): ClientRequestImpl => {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const opts = { ...(options as RequestOptions | undefined), method: "GET" } as RequestOptions;
  const req = new ClientRequestImpl(urlOrOpts, opts, callback);
  req.end();
  return req;
};

export type IncomingMessage = IncomingMessageImpl;
export type ServerResponse = ServerResponseImpl;
export type ClientRequest = ClientRequestImpl;

export interface Server {
  listen(port?: number, host?: string, callback?: () => void): Server;
  close(): Server;
  on(event: string, listener: (...args: any[]) => void): Server;
}

export const createHttpShim = (sandbox?: SWSandbox, options?: HttpShimOptions) => {
  const { onPortEvent } = options ?? {};

  const createServer = (handler?: (req: IncomingMessage, res: ServerResponse) => void) => {
    if (!sandbox) {
      throw new Error(
        "http.createServer requires an SWSandbox; client methods (request/get) are available without one",
      );
    }
    const server = new EventEmitter() as unknown as Server;
    let listening = false;
    let serverPort = 0;

    server.listen = (port?: number, host?: string, callback?: () => void) => {
      const actualPort = port ?? 3000;
      const url = `/__virtual__/${actualPort}`;

      listening = true;
      serverPort = actualPort;

      onPortEvent?.("server-ready", { port: actualPort, url });
      onPortEvent?.("port-open", { port: actualPort, url });

      const fetchHandler = async (req: Request) => {
        if (!listening) {
          return new Response("Server closed", { status: 503 });
        }

        const reqUrl = new URL(req.url);
        let pathname = reqUrl.pathname;
        const virtualMatch = pathname.match(/^\/__virtual__\/\d+(\/.*)?$/);
        if (virtualMatch) {
          pathname = virtualMatch[1] || "/";
        }
        const body = req.body ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
        const request = new IncomingMessageImpl({
          url: pathname + reqUrl.search,
          method: req.method,
          headers: lowerCaseHeaders(Object.fromEntries(req.headers.entries())),
          body,
        });
        const response = new ServerResponseImpl();

        // Real completion is always signaled by `res.end()` — possibly after
        // async body-parsing middleware has consumed `request`'s 'data'/'end'
        // events — not by the handler function itself returning, which most
        // http frameworks (Express, plain `http.createServer`) never await.
        const responseFinished = new Promise<void>((resolve) => {
          response.once("finish", () => resolve());
        });

        const result = handler?.(request, response);
        if (result && typeof (result as Promise<unknown>).then === "function") {
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
        onPortEvent?.("port-close", { port: serverPort });
        listening = false;
      }
      return server;
    };

    return server;
  };

  return {
    createServer,
    request,
    get,
    ClientRequest: ClientRequestImpl,
    IncomingMessage: IncomingMessageImpl,
    ServerResponse: ServerResponseImpl,
    Agent,
    globalAgent,
    createAgent,
  };
};

export const createNetShim = (sandbox?: SWSandbox, options?: HttpShimOptions) => {
  const http = createHttpShim(sandbox, options);

  const connectError = (): never => {
    throw new Error(
      "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage",
    );
  };

  const connect = (_options: NetConnectOptions, _connectionListener?: () => void): never =>
    connectError();

  class Socket {
    constructor() {
      connectError();
    }
  }

  const isIP = (input: string): number => {
    if (!input || typeof input !== "string") return 0;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) {
      const parts = input.split(".");
      if (parts.every((part) => parseInt(part, 10) <= 255)) return 4;
    }
    if (/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(input)) return 6;
    return 0;
  };

  return {
    createServer: http.createServer,
    connect,
    Socket,
    isIP,
  };
};
