import type { SWSandbox } from "@bolojs/sandbox";
import { createEventsShim, createStreamShim, createBufferShim } from "@bolojs/node-web-shims";

const { EventEmitter } = createEventsShim();
const { Readable, Writable } = createStreamShim();
// `createBufferShim`'s declared return type loses the `Buffer` member (a pre-existing
// tsc declaration-emit quirk on unenv's untyped default export), so read it off the
// runtime value instead of trusting the type.
const { Buffer } = createBufferShim() as unknown as { Buffer: typeof globalThis.Buffer };

export const METHODS = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
];

export const STATUS_CODES: Record<number | string, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

export const maxHeaderSize = 16384;

/**
 * Loop-liveness for in-flight requests and listening servers. Node keeps the
 * process alive while a socket is open; inside a process worker
 * `__browserContainers.timers` is the loop-backed timers API, so a
 * far-future timer stands in for the socket handle (same trick as
 * net-shim's NetHandleTracker). Outside a worker there is no loop to feed,
 * so this is a no-op.
 */
interface LoopTimersLike {
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const loopTimers = (): LoopTimersLike | undefined =>
  (globalThis as { __browserContainers?: { timers?: LoopTimersLike } }).__browserContainers?.timers;

const acquireLoopLiveness = (): (() => void) => {
  const timers = loopTimers();
  const timer = timers?.setTimeout?.(() => {}, 0x7fffffff);
  return () => {
    if (timer !== undefined) timers?.clearTimeout?.(timer);
  };
};

export const validateHeaderName = (name: unknown): void => {
  if (typeof name !== "string" || !/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) {
    // Node: ERR_INVALID_HTTP_TOKEN 'Header name must be a valid HTTP token
    // ["<value>"]' — the value is interpolated for any type (3840 → "3840").
    const err = new TypeError(`Header name must be a valid HTTP token ["${String(name)}"]`);
    (err as unknown as { code: string }).code = "ERR_INVALID_HTTP_TOKEN";
    throw err;
  }
};

const INVALID_HEADER_VALUE_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

const checkHeaderValueChars = (name: string, value: string): void => {
  const match = INVALID_HEADER_VALUE_CHAR.exec(value);
  if (match) {
    const err = new TypeError(`Invalid character in header content ["${match[0]}"]`);
    (err as unknown as { code: string }).code = "ERR_INVALID_CHAR";
    throw err;
  }
};

export const validateHeaderValue = (name: string, value: unknown): void => {
  if (value === undefined || value === null) {
    const err = new TypeError(`Invalid value "${value}" for header "${name}"`);
    (err as unknown as { code: string }).code = "ERR_HTTP_INVALID_HEADER_VALUE";
    throw err;
  }
};

/** Node's setHeader/appendHeader value contract: string | number | string[]. */
const normalizeHeaderValue = (name: string, value: unknown): string => {
  validateHeaderName(name);
  validateHeaderValue(name, value);
  const parts = Array.isArray(value) ? value : [value];
  for (const part of parts) {
    if (typeof part !== "string" && typeof part !== "number") {
      throw invalidArgTypeForHeader(name, part);
    }
    checkHeaderValueChars(name, String(part));
  }
  return parts.map(String).join(", ");
};

const invalidArgTypeForHeader = (name: string, value: unknown): TypeError => {
  const err = new TypeError(
    `The "value" argument must be of type string or an instance of Array or number. Received ${
      value === null
        ? "null"
        : typeof value === "object"
          ? "an instance of Object"
          : `type ${typeof value}`
    } for header "${name}"`,
  ) as TypeError & { code: string };
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
};

const headersSentError = (): Error & { code: string } =>
  Object.assign(new Error("Cannot set headers after they are sent to the client"), {
    code: "ERR_HTTP_HEADERS_SENT",
  });

export const setMaxIdleHTTPParsers = (_max: number): void => {};

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
  agent?: AgentImpl | boolean | null;
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
    // Node merges option fields over a URL argument (https.get(url, opts)).
    const url = new URL(urlOrOpts.href);
    if (options) applyRequestUrlOptions(url, options);
    return url;
  }
  const opts = urlOrOpts;
  const url = new URL("http://localhost/");
  applyRequestUrlOptions(url, opts);
  if (options) applyRequestUrlOptions(url, options);
  return url;
};

/**
 * Apply Node's options-object URL fields onto a URL. `path` may carry a
 * query string (`/x?y=1`), which `URL.pathname` alone would drop.
 */
const applyRequestUrlOptions = (url: URL, opts: RequestOptions): void => {
  if (opts.protocol) url.protocol = `${opts.protocol.replace(/:$/, "")}:`;
  const hostField = opts.hostname ?? opts.host;
  if (hostField) {
    // `host` may include a port (`example.com:8080`).
    const colon = hostField.lastIndexOf(":");
    const hasPort = colon > 0 && /^\d+$/.test(hostField.slice(colon + 1));
    url.hostname = hasPort ? hostField.slice(0, colon) : hostField;
    if (hasPort && opts.port === undefined) url.port = hostField.slice(colon + 1);
  }
  if (opts.port !== undefined && opts.port !== "") url.port = String(opts.port);
  if (opts.path !== undefined) {
    const q = opts.path.indexOf("?");
    url.pathname = q === -1 ? opts.path : opts.path.slice(0, q);
    url.search = q === -1 ? "" : opts.path.slice(q);
  }
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
  readonly rawHeaders: string[];
  readonly httpVersion = "1.1";
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly socket: unknown;
  readonly connection: unknown;
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
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
    rawHeaders?: string[];
    autoEmit?: boolean;
  }) {
    super();
    this.url = init.url;
    this.method = init.method;
    this.headers = init.headers;
    this.rawHeaders = init.rawHeaders ?? Object.entries(init.headers).flatMap(([k, v]) => [k, v]);
    this.statusCode = init.statusCode;
    this.statusMessage = init.statusMessage;
    this.body = init.body;

    const dummySocket = new EventEmitter();
    (dummySocket as unknown as Record<string, unknown>).remoteAddress = "127.0.0.1";
    (dummySocket as unknown as Record<string, unknown>).remotePort = 3000;
    (dummySocket as unknown as Record<string, unknown>).localAddress = "127.0.0.1";
    (dummySocket as unknown as Record<string, unknown>).localPort = 3000;
    (dummySocket as unknown as Record<string, unknown>).encrypted = false;
    (dummySocket as unknown as Record<string, unknown>).destroy = () => dummySocket;
    (dummySocket as unknown as Record<string, unknown>).ref = () => dummySocket;
    (dummySocket as unknown as Record<string, unknown>).unref = () => dummySocket;
    this.socket = dummySocket;
    this.connection = dummySocket;

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

export class OutgoingMessageImpl extends Writable {
  statusCode = 200;
  statusMessage?: string;
  headersSent = false;
  sendDate = true;
  chunkedEncoding = false;
  shouldKeepAlive = true;
  useChunkedEncodingByDefault = true;
  readonly socket: unknown;
  readonly connection: unknown;
  protected responseHeaders: Record<string, string> = { "content-type": "text/plain" };
  /** Original-case header names for `rawHeaders` (Node keeps send-order pairs). */
  protected readonly headerDisplayNames = new Map<string, string>();
  protected chunks: Uint8Array[] = [];

  constructor() {
    super();
    const dummySocket = new EventEmitter();
    (dummySocket as unknown as Record<string, unknown>).remoteAddress = "127.0.0.1";
    (dummySocket as unknown as Record<string, unknown>).remotePort = 3000;
    (dummySocket as unknown as Record<string, unknown>).localAddress = "127.0.0.1";
    (dummySocket as unknown as Record<string, unknown>).localPort = 3000;
    (dummySocket as unknown as Record<string, unknown>).encrypted = false;
    (dummySocket as unknown as Record<string, unknown>).destroy = () => dummySocket;
    (dummySocket as unknown as Record<string, unknown>).ref = () => dummySocket;
    (dummySocket as unknown as Record<string, unknown>).unref = () => dummySocket;
    this.socket = dummySocket;
    this.connection = dummySocket;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    if (this.headersSent) throw headersSentError();
    // Node validates the name's TYPE before stringifying: a numeric name
    // throws ERR_INVALID_HTTP_TOKEN even though "3840" is a valid token.
    validateHeaderName(name);
    const key = String(name).toLowerCase();
    this.responseHeaders[key] = normalizeHeaderValue(String(name), value);
    this.headerDisplayNames.set(key, String(name));
    return this;
  }

  getHeader(key: string): string | undefined {
    return this.responseHeaders[key.toLowerCase()];
  }

  hasHeader(key: string): boolean {
    return key.toLowerCase() in this.responseHeaders;
  }

  removeHeader(key: string): void {
    const lower = String(key).toLowerCase();
    delete this.responseHeaders[lower];
    this.headerDisplayNames.delete(lower);
  }

  getHeaderNames(): string[] {
    return Object.keys(this.responseHeaders);
  }

  getHeaders(): Record<string, string> {
    return { ...this.responseHeaders };
  }

  /** `[name, value, name, value, …]` pairs preserving original header casing. */
  rawHeaderPairs(): string[] {
    return Object.entries(this.responseHeaders).flatMap(([key, value]) => [
      this.headerDisplayNames.get(key) ?? key,
      value,
    ]);
  }

  appendHeader(name: string, value: string | readonly string[]): this {
    if (this.headersSent) throw headersSentError();
    const key = String(name).toLowerCase();
    const valStr = normalizeHeaderValue(name, value);
    const existing = this.responseHeaders[key];
    this.responseHeaders[key] = existing ? `${existing}, ${valStr}` : valStr;
    if (!existing) this.headerDisplayNames.set(key, String(name));
    return this;
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  addTrailers(_headers: Record<string, string>): void {}

  override _write(
    chunk: unknown,
    _encoding: string,
    callback?: (error?: Error | null) => void,
  ): void {
    this.chunks.push(toBytes(chunk));
    this.headersSent = true;
    // Local dispatch treats the first body chunk like Node's header flush:
    // a handler that streams (`write` without `end`) still reaches the
    // client instead of hanging the request forever.
    this.emit("firstChunk");
    callback?.();
  }
}

/**
 * unenv's own `Writable` already buffers written chunks and emits
 * 'finish'/'close' from `end()`, so only the http-specific surface
 * (writeHead/setHeader/statusCode/headersSent) plus the chunk capture
 * needed to build the final `Response` are added here.
 */
class ServerResponseImpl extends OutgoingMessageImpl {
  /**
   * `writeHead(status[, reason][, headers])`. Node semantics:
   * - headers may be a flat `[name, value, …]` array or an object;
   * - a string second arg is the reason phrase;
   * - calling it after headers were sent throws ERR_HTTP_HEADERS_SENT;
   * - an out-of-range status throws ERR_HTTP_INVALID_STATUS_CODE;
   * - a flat header array with an odd number of entries throws
   *   ERR_INVALID_ARG_VALUE;
   * - without an explicit reason phrase the status message defaults to the
   *   standard reason for the code, or "unknown" for non-standard codes.
   */
  writeHead(
    statusCode: number,
    reasonOrHeaders?: string | Record<string, string | string[]> | (string | number)[],
    headers?: Record<string, string | string[]> | (string | number)[],
  ): this {
    if (this.headersSent) throw headersSentError();
    if (
      typeof statusCode !== "number" ||
      !Number.isInteger(statusCode) ||
      statusCode < 100 ||
      statusCode > 999
    ) {
      const err = new TypeError(`Invalid status code: ${statusCode}`) as TypeError & {
        code: string;
      };
      err.code = "ERR_HTTP_INVALID_STATUS_CODE";
      throw err;
    }
    this.statusCode = statusCode;
    let headerSource: Record<string, string | string[]> | (string | number)[] | undefined;
    if (typeof reasonOrHeaders === "string") {
      this.statusMessage = reasonOrHeaders;
      headerSource = headers;
    } else {
      headerSource = reasonOrHeaders ?? headers;
      // Node: `this.statusMessage ||= STATUS_CODES[statusCode] || 'unknown'`.
      if (!this.statusMessage) {
        this.statusMessage = STATUS_CODES[statusCode] || "unknown";
      }
    }
    if (headerSource) this.applyWriteHeadHeaders(headerSource);
    this.headersSent = true;
    return this;
  }

  /**
   * Merge writeHead-supplied headers into the pending set. Flat arrays are
   * `[name, value, name, value, …]`; objects go through the same
   * validation/casing path as `setHeader`.
   */
  private applyWriteHeadHeaders(
    source: Record<string, string | string[]> | (string | number)[],
  ): void {
    if (Array.isArray(source)) {
      // Node: `if (obj.length % 2 !== 0) throw new ERR_INVALID_ARG_VALUE('headers', obj)`.
      if (source.length % 2 !== 0) {
        const err = new TypeError(
          `The value of "headers" is invalid. Received ${String(source)}`,
        ) as TypeError & { code: string };
        err.code = "ERR_INVALID_ARG_VALUE";
        throw err;
      }
      for (let i = 0; i + 1 < source.length; i += 2) {
        const name = source[i];
        const value = source[i + 1];
        // Pass the raw name so a non-string entry fails Node's
        // ERR_INVALID_HTTP_TOKEN check instead of being stringified first.
        const valStr = normalizeHeaderValue(name as string, value);
        const key = String(name).toLowerCase();
        this.responseHeaders[key] = valStr;
        this.headerDisplayNames.set(key, String(name));
      }
      return;
    }
    for (const [name, value] of Object.entries(source)) {
      const key = name.toLowerCase();
      this.responseHeaders[key] = normalizeHeaderValue(String(name), value);
      this.headerDisplayNames.set(key, name);
    }
  }

  /** Concatenated response body chunks (local-dispatch path). */
  bodyBytes(): Uint8Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  toResponse(): Response {
    const statusText = this.statusMessage ?? STATUS_CODES[this.statusCode] ?? "";
    const init = { status: this.statusCode, headers: this.responseHeaders };
    try {
      return new Response(this.bodyBytes() as unknown as BodyInit, { ...init, statusText });
    } catch {
      // `Response` rejects reason phrases with bytes outside the HTTP token
      // range and 1xx/6xx+ statuses — the sandbox path degrades gracefully.
      try {
        return new Response(this.bodyBytes() as unknown as BodyInit, {
          ...init,
          status: 200,
          statusText: "",
        });
      } catch {
        return new Response(this.bodyBytes() as unknown as BodyInit);
      }
    }
  }
}

/**
 * In-realm http servers keyed by listen port. `http.get`/`request` aimed at
 * a loopback port served by a `ServerImpl` in this same realm dispatch
 * directly — matching Node semantics where client and server share a
 * process — instead of round-tripping through the service-worker fetch
 * proxy (which only exists for cross-realm/sandboxed traffic).
 */
const localHttpServers = new Map<number, ServerImpl>();

/** Ephemeral listen() ports, matching the net shim's loopback range. */
let nextEphemeralHttpPort = 49153;

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname === "";

interface LocalDispatchResult {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string>;
  rawHeaders: string[];
  body: Uint8Array;
}

/** Run one request through a ServerImpl's 'request' listeners, in-realm. */
const dispatchLocalRequest = async (
  server: ServerImpl,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
): Promise<LocalDispatchResult> => {
  let pathname = url.pathname;
  const virtualMatch = pathname.match(/^\/__virtual__\/\d+(\/.*)?$/);
  if (virtualMatch) pathname = virtualMatch[1] || "/";
  const request = new IncomingMessageImpl({
    url: pathname + url.search,
    method,
    headers: lowerCaseHeaders(headers),
    body,
  });
  const response = new ServerResponseImpl();
  const snapshot = (): LocalDispatchResult => {
    const rawHeaders = response.rawHeaderPairs();
    const responseHeaders: Record<string, string> = {};
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      responseHeaders[rawHeaders[i].toLowerCase()] = rawHeaders[i + 1];
    }
    return {
      statusCode: response.statusCode,
      statusMessage: response.statusMessage,
      headers: responseHeaders,
      rawHeaders,
      body: response.bodyBytes(),
    };
  };
  let settled = false;
  let finished = false;
  const result = new Promise<LocalDispatchResult>((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(snapshot());
    };
    response.once("finish", () => {
      finished = true;
      settle();
    });
    // `res.write` without `end` still delivers its first chunk — resolve on
    // a macrotask so a same-tick `end()` wins and buffered bodies stay whole.
    response.once("firstChunk", () => {
      setTimeout(() => {
        if (!finished) settle();
      }, 0);
    });
  });
  server.emit("request", request, response);
  return result;
};

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
      const connection = (agent as AgentImpl).get(origin);
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

  /** Loopback port served by an in-realm ServerImpl, if any. */
  private localTarget(): ServerImpl | undefined {
    if (!isLoopbackHost(this.url.hostname)) return undefined;
    const port = this.url.port ? Number(this.url.port) : this.url.protocol === "https:" ? 443 : 80;
    const server = localHttpServers.get(port);
    return server && server.listening ? server : undefined;
  }

  private _emitClientResponse(parts: {
    statusCode: number;
    statusMessage?: string;
    headers: Record<string, string>;
    rawHeaders?: string[];
    body: Uint8Array;
  }): void {
    this.response = new IncomingMessageImpl({
      headers: parts.headers,
      rawHeaders: parts.rawHeaders,
      body: parts.body,
      statusCode: parts.statusCode,
      statusMessage: parts.statusMessage,
      autoEmit: false,
    });
    this.emit("response", this.response);
    this.response.emitBody();
    this.emit("finish");
  }

  private async _send(): Promise<void> {
    if (this.aborted) return;
    // An in-flight request is a live handle in Node — without it the worker
    // could hit beforeExit while a slow/streaming response is pending.
    const releaseLiveness = acquireLoopLiveness();
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const body = length > 0 ? new Uint8Array(length) : undefined;
    if (body) {
      let offset = 0;
      for (const chunk of this.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    try {
      const local = this.localTarget();
      if (local) {
        const dispatched = await dispatchLocalRequest(
          local,
          this.url,
          this.method,
          this.headers,
          body,
        );
        this._emitClientResponse(dispatched);
      } else {
        const init: RequestInit = {
          method: this.method,
          headers: this.headers,
          signal: this.abortController.signal,
        };
        if (body) init.body = body;
        const res = await globalThis.fetch(this.url, init);
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const responseBody = new Uint8Array(await res.arrayBuffer());
        this._emitClientResponse({
          headers: responseHeaders,
          body: responseBody,
          statusCode: res.status,
          statusMessage: res.statusText,
        });
      }
      if (this.timeoutId) clearTimeout(this.timeoutId);
    } catch (err) {
      if (this.timeoutId) clearTimeout(this.timeoutId);
      if (!this.aborted) this.emit("error", err);
    } finally {
      releaseLiveness();
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

interface AgentOptions {
  maxSockets?: number;
  maxFreeSockets?: number;
  keepAlive?: boolean;
}

/**
 * Function-style constructor (like Node's `http.Agent`): callable with or
 * without `new`, and `instanceof`-compatible in both directions.
 */
function AgentImpl(this: AgentImpl, options?: AgentOptions) {
  this.maxSockets = options?.maxSockets ?? Infinity;
  this.maxFreeSockets = options?.maxFreeSockets ?? 256;
  this.keepAlive = options?.keepAlive ?? false;
  this.connections = new Map<string, { controller: AbortController; count: number }>();
}

interface AgentImpl {
  maxSockets: number;
  maxFreeSockets: number;
  keepAlive: boolean;
  connections: Map<string, { controller: AbortController; count: number }>;
  get(origin: string): { controller: AbortController; detach: () => void };
  destroy(): void;
}

AgentImpl.prototype.get = function get(origin: string) {
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
};

AgentImpl.prototype.destroy = function destroy() {
  for (const { controller } of this.connections.values()) {
    controller.abort();
  }
  this.connections.clear();
};

/**
 * `http.Agent` — Node's is a function-style constructor: callable without
 * `new` and `instanceof`-compatible in both directions
 * (`https.Agent() instanceof https.Agent` must hold).
 */
export const Agent = function Agent(this: AgentImpl, options?: AgentOptions): AgentImpl {
  if (!(this instanceof AgentImpl))
    return new (AgentImpl as unknown as { new (o?: AgentOptions): AgentImpl })(options);
  AgentImpl.call(this, options);
  return this;
} as unknown as {
  new (options?: AgentOptions): AgentImpl;
  (options?: AgentOptions): AgentImpl;
  prototype: AgentImpl;
};

// `x instanceof Agent` must hold for every agent instance, so the exported
// constructor shares the implementation prototype.
Object.defineProperty(Agent, "prototype", {
  value: AgentImpl.prototype,
  writable: false,
  configurable: false,
});

const globalAgent = new Agent();

export const createAgent = (options?: AgentOptions) =>
  new (AgentImpl as unknown as { new (o?: AgentOptions): AgentImpl })(options);

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
export type OutgoingMessage = OutgoingMessageImpl;

export interface HttpServer {
  listen(port?: unknown, host?: unknown, callback?: () => void): HttpServer;
  close(callback?: (err?: Error) => void): HttpServer;
  on(event: string, listener: (...args: any[]) => void): HttpServer;
  address(): { address: string; family: string; port: number } | null;
  setTimeout(msecs?: number, callback?: () => void): HttpServer;
}

export class ServerImpl extends EventEmitter implements HttpServer {
  listening = false;
  private serverPort = 0;
  private sandbox?: SWSandbox;
  private onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
  private releaseLiveness?: () => void;
  /** The sandbox fetch handler registered by `listen()` — unregistered on close. */
  private registeredFetchHandler?: (req: Request) => Promise<Response>;

  constructor(
    sandbox?: SWSandbox,
    optionsOrListener?: unknown,
    requestListener?: (req: IncomingMessageImpl, res: ServerResponseImpl) => void,
    onPortEvent?: (event: string, data: { port: number; url?: string }) => void,
  ) {
    super();
    this.sandbox = sandbox;
    this.onPortEvent = onPortEvent;
    const listener =
      typeof optionsOrListener === "function"
        ? (optionsOrListener as (req: IncomingMessageImpl, res: ServerResponseImpl) => void)
        : requestListener;
    if (listener) {
      this.on("request", listener);
    }
  }

  listen(port?: unknown, host?: unknown, callback?: () => void): this {
    let actualPort = 3000;
    let cb: (() => void) | undefined;
    if (typeof port === "number") {
      // Node assigns an ephemeral port for listen(0).
      actualPort = port === 0 ? nextEphemeralHttpPort++ : port || 3000;
      if (typeof host === "function") {
        cb = host as () => void;
      } else if (typeof callback === "function") {
        cb = callback;
      }
    } else if (typeof port === "function") {
      cb = port as () => void;
    } else if (typeof port === "object" && port !== null) {
      const optPort = (port as { port?: number }).port;
      actualPort = optPort === 0 ? nextEphemeralHttpPort++ : (optPort ?? 3000);
      cb = (typeof host === "function" ? host : callback) as (() => void) | undefined;
    }
    const url = `/__virtual__/${actualPort}`;

    this.listening = true;
    this.serverPort = actualPort;
    localHttpServers.set(actualPort, this);
    // A listening server keeps the process alive in Node — the loop handle
    // stands in for the accept socket.
    this.releaseLiveness ??= acquireLoopLiveness();

    this.onPortEvent?.("server-ready", { port: actualPort, url });
    this.onPortEvent?.("port-open", { port: actualPort, url });

    if (this.sandbox) {
      const fetchHandler = async (req: Request) => {
        if (!this.listening) {
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

        this.emit("request", request, response);
        await responseFinished;

        return response.toResponse();
      };

      this.sandbox.onFetch(fetchHandler);
      this.registeredFetchHandler = fetchHandler;
    }

    queueMicrotask(() => {
      this.emit("listening");
      // Node invokes the listen callback as a 'listening' listener, so `this`
      // is the server (`server.listen(0, function() { this.address() })`).
      cb?.call(this);
    });
    return this;
  }

  close(callback?: (err?: Error) => void): this {
    this.releaseLiveness?.();
    this.releaseLiveness = undefined;
    // Node: closing the server stops accepting — the sandbox-side fetch
    // handler must go too, or the worker still reports a live server and
    // never reaches natural exit.
    const sandbox = this.sandbox as
      | { removeFetch?: (handler: (req: Request) => Promise<Response>) => void }
      | undefined;
    if (sandbox?.removeFetch && this.registeredFetchHandler) {
      sandbox.removeFetch(this.registeredFetchHandler);
      this.registeredFetchHandler = undefined;
    }
    if (this.listening) {
      this.onPortEvent?.("port-close", { port: this.serverPort });
      this.listening = false;
      if (localHttpServers.get(this.serverPort) === this) {
        localHttpServers.delete(this.serverPort);
      }
    }
    queueMicrotask(() => {
      this.emit("close");
      callback?.();
    });
    return this;
  }

  address() {
    return {
      address: "127.0.0.1",
      family: "IPv4",
      port: this.serverPort,
    };
  }

  setTimeout(msecs = 0, callback?: () => void): this {
    if (callback) this.on("timeout", callback);
    return this;
  }
}

export type RequestListener = (req: IncomingMessageImpl, res: ServerResponseImpl) => void;

export interface ServerConstructor {
  new (requestListener?: RequestListener): ServerImpl;
  new (options: unknown, requestListener?: RequestListener): ServerImpl;
  (requestListener?: RequestListener): ServerImpl;
  (options: unknown, requestListener?: RequestListener): ServerImpl;
}

export function createServerConstructor(
  sandbox?: SWSandbox,
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void,
): ServerConstructor {
  function Server(this: unknown, optionsOrListener?: unknown, requestListener?: RequestListener) {
    return new ServerImpl(sandbox, optionsOrListener, requestListener, onPortEvent);
  }
  Server.prototype = ServerImpl.prototype;
  Object.setPrototypeOf(Server, ServerImpl);
  return Server as unknown as ServerConstructor;
}

export const Server = createServerConstructor();
export type Server = ServerImpl;

export const createHttpShim = (sandbox?: SWSandbox, options?: HttpShimOptions) => {
  const { onPortEvent } = options ?? {};
  const Server = createServerConstructor(sandbox, onPortEvent);

  function createServer(requestListener?: RequestListener): ServerImpl;
  function createServer(options: unknown, requestListener?: RequestListener): ServerImpl;
  function createServer(
    optionsOrListener?: unknown,
    requestListener?: RequestListener,
  ): ServerImpl {
    return new (Server as unknown as { new (a?: unknown, b?: unknown): ServerImpl })(
      optionsOrListener,
      requestListener,
    );
  }

  return {
    createServer,
    Server,
    request,
    get,
    ClientRequest: ClientRequestImpl,
    IncomingMessage: IncomingMessageImpl,
    ServerResponse: ServerResponseImpl,
    OutgoingMessage: OutgoingMessageImpl,
    Agent,
    globalAgent,
    createAgent,
    METHODS,
    STATUS_CODES,
    maxHeaderSize,
    validateHeaderName,
    validateHeaderValue,
    setMaxIdleHTTPParsers,
  };
};
