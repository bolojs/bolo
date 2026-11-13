import type { NetConnectOptions, StreamSocket } from "./live.js";
import { events, stream, unsupportedError } from "@bolojs/node-web-shims";

const EventEmitter = events;
const DuplexCtor = stream.Duplex;

// ---------------------------------------------------------------------------
// Coded errors (Node's internal/errors.js errno-exception pattern, mirroring
// the `makeError` helper in @bolojs/node-web-shims/src/stream.ts)
// ---------------------------------------------------------------------------

interface ErrnoException extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
}

const makeError = (code: string, message: string): Error & { code: string } => {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
};

/**
 * Builds a Node-style errno exception: `connect ECONNREFUSED 127.0.0.1:80`
 * with `code`/`syscall`/`address`/`port` attached, like Node's
 * `exceptionWithHostPort`.
 */
const errnoException = (
  code: string,
  syscall: string,
  address?: string,
  port?: number,
): ErrnoException => {
  const details =
    address === undefined ? (port ?? "") : `${address}${port === undefined ? "" : `:${port}`}`;
  const err = new Error(
    `${syscall} ${code}${details === "" ? "" : ` ${details}`}`,
  ) as ErrnoException;
  err.code = code;
  err.syscall = syscall;
  if (address !== undefined) err.address = address;
  if (port !== undefined) err.port = port;
  return err;
};

const invalidArgType = (name: string, expected: string, actual: unknown): TypeError => {
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${typeof actual === "object" && actual !== null ? "object" : `type ${typeof actual}`}`,
  ) as TypeError & { code: string };
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
};

const outOfRange = (name: string, range: string, actual: unknown): RangeError => {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${actual}`,
  ) as RangeError & { code: string };
  err.code = "ERR_OUT_OF_RANGE";
  return err;
};

const validatePort = (port: unknown, name = "port", allowZero = false): number => {
  const legal = typeof port === "number" && port === (port | 0) && port >= 0 && port <= 0xffff;
  if (!legal || (port === 0 && !allowZero)) {
    throw outOfRange(name, `>= ${allowZero ? 0 : 1} and < 65536`, port);
  }
  return port;
};

// ---------------------------------------------------------------------------
// TCP relay wire protocol (binary frames over a single WebSocket):
//   [1B type][8B ascii connectionId][payload]
// ---------------------------------------------------------------------------

const FRAME_TYPE = {
  CONNECT: 0x01,
  CONNECTED: 0x02,
  DATA: 0x03,
  CLOSE: 0x04,
  ERROR: 0x05,
  LISTEN: 0x06,
  LISTENING: 0x07,
  ACCEPT: 0x08,
  UNLISTEN: 0x09,
  UNLISTENED: 0x0a,
  DESTROY: 0x0b,
} as const;

const LISTENER_CONNECTION_ID = "00000000";
const EMPTY_PAYLOAD = new Uint8Array(0);

const jsonPayload = (obj: object): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

const buildFrame = (type: number, connectionId: string, payload: Uint8Array): Uint8Array => {
  const id = connectionId.padStart(8, "0");
  const idBytes = new TextEncoder().encode(id);
  const frame = new Uint8Array(1 + idBytes.length + payload.length);
  frame[0] = type;
  frame.set(idBytes, 1);
  frame.set(payload, 1 + idBytes.length);
  return frame;
};

const parseFrame = (
  bytes: Uint8Array,
): { type: number; connectionId: string; payload: Uint8Array } => {
  if (bytes.length < 9) {
    throw new Error(`Frame too short: ${bytes.length} bytes`);
  }
  const type = bytes[0] ?? 0;
  const connectionId = new TextDecoder().decode(bytes.slice(1, 9));
  const payload = bytes.slice(9);
  return { type, connectionId, payload };
};

const wsSend = (ws: WebSocket, frame: Uint8Array): void => {
  ws.send(frame as unknown as ArrayBufferView<ArrayBuffer>);
};

// ---------------------------------------------------------------------------
// Byte transport seam
// ---------------------------------------------------------------------------

export interface AcceptedConnection {
  connectionId: string;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  remoteAddress: string;
  remotePort: number;
  onError?: (err: Error) => void;
}

export interface ByteTransport {
  connect(
    options: NetConnectOptions,
    onControl: (msg: object) => void,
    onError?: (err: Error) => void,
  ): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    remoteAddress?: string;
    remotePort?: number;
    localAddress?: string;
    localPort?: number;
  }>;
  listen(
    port: number,
    host: string,
    onConnection: (conn: AcceptedConnection) => void,
    onControl: (msg: object) => void,
  ): Promise<{ port: number; host: string; close: () => Promise<void> }>;
}

const NOOP_CONNECT_ERROR =
  "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage";
const NOOP_LISTEN_ERROR =
  "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage";

export class NoopTransport implements ByteTransport {
  connect(
    _options?: NetConnectOptions,
    _onControl?: (msg: object) => void,
    _onError?: (err: Error) => void,
  ): Promise<never> {
    throw unsupportedError("NET_BACKEND", NOOP_CONNECT_ERROR);
  }

  listen(
    _port: number,
    _host: string,
    _onConnection: (conn: AcceptedConnection) => void,
    _onControl: (msg: object) => void,
  ): Promise<never> {
    throw unsupportedError("NET_BACKEND", NOOP_LISTEN_ERROR);
  }
}

/**
 * In-process loopback transport: `net.Server.listen` + `net.connect` pair
 * client and server sockets inside the same realm through crossed
 * ReadableStream/WritableStream pipes — no network, no relay. Real TCP
 * semantics that map cleanly: connect to an unbound port → ECONNREFUSED,
 * listen on a bound port → EADDRINUSE, peer close → stream EOF. This is
 * the default when no `tcpRelay`/custom transport is configured, so
 * client↔server tests in one container behave like Node's loopback.
 */
export class LoopbackTransport implements ByteTransport {
  private readonly listeners = new Map<
    string,
    { host: string; port: number; onConnection: (conn: AcceptedConnection) => void }
  >();
  private nextEphemeralPort = 49152;
  private nextConnectionId = 1;

  private static key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private static wildcard(host: string): boolean {
    return (
      host === "0.0.0.0" ||
      host === "::" ||
      host === "*" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1"
    );
  }

  connect(
    options: NetConnectOptions,
    _onControl?: (msg: object) => void,
    _onError?: (err: Error) => void,
  ): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    remoteAddress?: string;
    remotePort?: number;
    localAddress?: string;
    localPort?: number;
  }> {
    const host = options.host ?? "localhost";
    const port = options.port;
    const listener = [...this.listeners.values()].find(
      (l) => l.port === port && (LoopbackTransport.wildcard(l.host) || l.host === host),
    );
    if (!listener) {
      return Promise.reject(errnoException("ECONNREFUSED", "connect", host, port));
    }

    // Pipe A: client→server. Pipe B: server→client. Closing/aborting one
    // side's writable ends/errors the other side's readable — FIN/RST.
    const a = createPipe();
    const b = createPipe();
    const localPort = this.nextEphemeralPort++;
    const accepted: AcceptedConnection = {
      connectionId: String(this.nextConnectionId++).padStart(8, "0"),
      readable: a.readable,
      writable: b.writable,
      remoteAddress: host,
      remotePort: localPort,
    };
    listener.onConnection(accepted);
    return Promise.resolve({
      readable: b.readable,
      writable: a.writable,
      remoteAddress: host,
      remotePort: port,
      localAddress: host,
      localPort,
    });
  }

  listen(
    port: number,
    host: string,
    onConnection: (conn: AcceptedConnection) => void,
    _onControl: (msg: object) => void,
  ): Promise<{ port: number; host: string; close: () => Promise<void> }> {
    const boundPort = port === 0 ? this.nextEphemeralPort++ : port;
    const boundHost = host || "0.0.0.0";
    const key = LoopbackTransport.key(boundHost, boundPort);
    if (this.listeners.has(key) || [...this.listeners.values()].some((l) => l.port === boundPort)) {
      return Promise.reject(errnoException("EADDRINUSE", "listen", boundHost, boundPort));
    }
    this.listeners.set(key, { host: boundHost, port: boundPort, onConnection });
    return Promise.resolve({
      port: boundPort,
      host: boundHost,
      close: () => {
        this.listeners.delete(key);
        return Promise.resolve();
      },
    });
  }
}

/**
 * Realm-wide default loopback: bare `new Socket()`/`new Server()` and every
 * `createNetShim` without a configured backend share one in-process loopback
 * namespace, mirroring Node where all realm code sees the same localhost.
 */
const defaultLoopback = new LoopbackTransport();

/**
 * A half of a loopback connection: writes feed the peer's readable. The
 * writable is intentionally not back-pressured by the reader (loopback
 * buffers are unbounded in Node too — the kernel manages them, and the
 * reader drains on its own schedule).
 */
const createPipe = (): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      controller.enqueue(chunk);
    },
    close() {
      try {
        controller.close();
      } catch {
        /* peer already errored */
      }
    },
    abort(reason) {
      try {
        controller.error(reason ?? new Error("ECONNRESET"));
      } catch {
        /* already closed */
      }
    },
  });
  return { readable, writable };
};

export class WebSocketTransport implements ByteTransport {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(
    options: NetConnectOptions,
    onControl: (msg: object) => void,
    onError?: (err: Error) => void,
  ): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      let connectionId: string | undefined;
      let readableController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let resolved = false;
      let refCount = 1;

      const cleanup = () => {
        readableController?.close();
        readableController = undefined;
      };

      const maybeClose = () => {
        if (refCount <= 0 && ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
      };

      const emitError = (err: Error) => {
        onError?.(err);
      };

      ws.onopen = () => {
        wsSend(
          ws,
          buildFrame(
            FRAME_TYPE.CONNECT,
            LISTENER_CONNECTION_ID,
            jsonPayload({
              host: options.host ?? "localhost",
              port: options.port,
            }),
          ),
        );
      };

      ws.onerror = (event) => {
        const err = resolved
          ? new Error(`WebSocket error: ${event.type}`)
          : errnoException("ECONNREFUSED", "connect", options.host, options.port);
        if (!resolved) {
          reject(err);
        } else {
          emitError(err);
        }
        cleanup();
        ws.close();
      };

      ws.onclose = () => {
        cleanup();
      };

      ws.onmessage = (event) => {
        const bytes =
          typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : new Uint8Array(event.data);
        let type: number;
        let id: string;
        let payload: Uint8Array;
        try {
          ({ type, connectionId: id, payload } = parseFrame(bytes));
        } catch (err) {
          emitError(err instanceof Error ? err : new Error(String(err)));
          ws.close();
          return;
        }
        if (type === FRAME_TYPE.CONNECTED) {
          resolved = true;
          connectionId = id;
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              readableController = controller;
            },
            cancel() {
              readableController = undefined;
            },
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) {
              if (!connectionId || ws.readyState !== WebSocket.OPEN) return;
              wsSend(ws, buildFrame(FRAME_TYPE.DATA, connectionId, chunk));
            },
            close() {
              if (connectionId && ws.readyState === WebSocket.OPEN) {
                wsSend(ws, buildFrame(FRAME_TYPE.CLOSE, connectionId, EMPTY_PAYLOAD));
              }
            },
            abort() {
              if (connectionId && ws.readyState === WebSocket.OPEN) {
                wsSend(ws, buildFrame(FRAME_TYPE.DESTROY, connectionId, EMPTY_PAYLOAD));
              }
              refCount--;
              maybeClose();
            },
          });
          resolve({ readable, writable });
        } else if (type === FRAME_TYPE.DATA) {
          if (readableController && id === connectionId) {
            readableController.enqueue(payload);
          }
        } else if (type === FRAME_TYPE.CLOSE) {
          cleanup();
          refCount--;
          maybeClose();
        } else if (type === FRAME_TYPE.ERROR) {
          const meta = JSON.parse(new TextDecoder().decode(payload));
          const err = new Error(meta.message ?? "TCP relay error") as Error & { code?: string };
          err.code = meta.code;
          if (!resolved) {
            reject(err);
          } else if (id === connectionId) {
            emitError(err);
            cleanup();
            refCount--;
            maybeClose();
          }
        } else {
          onControl({ type, connectionId: id, payload });
        }
      };
    });
  }

  listen(
    port: number,
    host: string,
    onConnection: (conn: AcceptedConnection) => void,
    onControl: (msg: object) => void,
  ): Promise<{ port: number; host: string; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      let listening = false;
      let closeResolve: (() => void) | undefined;
      let refCount = 1;
      const connections = new Map<
        string,
        {
          readableController: ReadableStreamDefaultController<Uint8Array>;
          accepted: AcceptedConnection;
        }
      >();

      // Closing a released/cancelled controller throws — `conn.onError` may
      // destroy the socket (cancelling its reader) before we get to close.
      const safeClose = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
        try {
          controller?.close();
        } catch {
          /* already released */
        }
      };

      const cleanup = () => {
        for (const { readableController } of connections.values()) {
          safeClose(readableController);
        }
        connections.clear();
      };

      const maybeClose = () => {
        if (refCount <= 0 && ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
      };

      const emitError = (connectionId: string, err: Error) => {
        const conn = connections.get(connectionId);
        conn?.accepted.onError?.(err);
      };

      ws.onopen = () => {
        wsSend(
          ws,
          buildFrame(FRAME_TYPE.LISTEN, LISTENER_CONNECTION_ID, jsonPayload({ port, host })),
        );
      };

      ws.onerror = (event) => {
        const err = listening
          ? new Error(`WebSocket error: ${event.type}`)
          : errnoException("EADDRINUSE", "listen", host, port);
        if (!listening) {
          reject(err);
        }
        for (const [id, conn] of connections) {
          conn.accepted.onError?.(err);
          safeClose(conn.readableController);
          connections.delete(id);
        }
        ws.close();
      };

      ws.onclose = () => {
        cleanup();
        if (closeResolve) {
          closeResolve();
          closeResolve = undefined;
        }
      };

      ws.onmessage = (event) => {
        const bytes =
          typeof event.data === "string"
            ? new TextEncoder().encode(event.data)
            : new Uint8Array(event.data);
        let type: number;
        let connectionId: string;
        let payload: Uint8Array;
        try {
          ({ type, connectionId, payload } = parseFrame(bytes));
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const [id, conn] of connections) {
            conn.accepted.onError?.(error);
            safeClose(conn.readableController);
            connections.delete(id);
          }
          ws.close();
          return;
        }
        if (type === FRAME_TYPE.LISTENING) {
          listening = true;
          const meta = payload.length > 0 ? JSON.parse(new TextDecoder().decode(payload)) : {};
          resolve({
            port: meta.port ?? port,
            host: meta.host ?? host,
            close: () =>
              new Promise((res) => {
                closeResolve = res;
                wsSend(ws, buildFrame(FRAME_TYPE.UNLISTEN, LISTENER_CONNECTION_ID, EMPTY_PAYLOAD));
              }),
          });
        } else if (type === FRAME_TYPE.ACCEPT) {
          const meta = JSON.parse(new TextDecoder().decode(payload));
          const id = connectionId;
          let readableController!: ReadableStreamDefaultController<Uint8Array>;
          const readable = new ReadableStream<Uint8Array>({
            start(controller) {
              readableController = controller;
            },
            cancel() {
              readableController =
                undefined as unknown as ReadableStreamDefaultController<Uint8Array>;
            },
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) {
              if (ws.readyState !== WebSocket.OPEN) return;
              wsSend(ws, buildFrame(FRAME_TYPE.DATA, id, chunk));
            },
            close() {
              if (ws.readyState === WebSocket.OPEN) {
                wsSend(ws, buildFrame(FRAME_TYPE.CLOSE, id, EMPTY_PAYLOAD));
              }
            },
            abort() {
              if (ws.readyState === WebSocket.OPEN) {
                wsSend(ws, buildFrame(FRAME_TYPE.DESTROY, id, EMPTY_PAYLOAD));
              }
              refCount--;
              maybeClose();
            },
          });
          const accepted: AcceptedConnection = {
            connectionId: id,
            readable,
            writable,
            remoteAddress: meta.remoteAddress,
            remotePort: meta.remotePort,
            onError: undefined,
          };
          refCount++;
          connections.set(id, { readableController, accepted });
          onConnection(accepted);
        } else if (type === FRAME_TYPE.DATA) {
          const conn = connections.get(connectionId);
          try {
            conn?.readableController?.enqueue(payload);
          } catch {
            /* reader already released (socket destroyed) — drop the chunk */
          }
        } else if (type === FRAME_TYPE.CLOSE) {
          const conn = connections.get(connectionId);
          safeClose(conn?.readableController);
          if (connections.delete(connectionId)) {
            refCount--;
            maybeClose();
          }
        } else if (type === FRAME_TYPE.ERROR) {
          const meta = JSON.parse(new TextDecoder().decode(payload));
          const err = new Error(meta.message ?? "TCP relay error") as Error & { code?: string };
          err.code = meta.code;
          emitError(connectionId, err);
          const conn = connections.get(connectionId);
          safeClose(conn?.readableController);
          if (connections.delete(connectionId)) {
            refCount--;
            maybeClose();
          }
        } else if (type === FRAME_TYPE.UNLISTENED) {
          refCount--;
          maybeClose();
          if (closeResolve) {
            closeResolve();
            closeResolve = undefined;
          }
        } else {
          onControl({ type, connectionId, payload });
        }
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Event-loop handle tracking
// ---------------------------------------------------------------------------

interface RefableTimer {
  ref?(): unknown;
  unref?(): unknown;
  hasRef?(): boolean;
}

/**
 * One live handle a Socket/Server holds against process liveness, like a
 * libuv handle in Node. `ref`/`unref` on the socket propagate here; the
 * event loop's `hasRefed()` must keep running while any ref'd handle lives.
 */
export interface NetLoopHandle {
  ref(): void;
  unref(): void;
  hasRef(): boolean;
  /** Drops the handle entirely (socket destroyed / server closed). */
  release(): void;
}

export interface NetHandleTracker {
  acquire(): NetLoopHandle;
  /** True while at least one acquired handle is live and ref'd. */
  hasRefed(): boolean;
}

// Deliberately not a `declare global`: `__browserContainers` is already
// declared (with a wider shape) by @bolojs/runtime's process worker — a
// second, narrower declaration here would conflict in consumers that type
// against both packages. Access goes through a structural cast instead.
const workerTimers = () =>
  (globalThis as { __browserContainers?: { timers?: object } }).__browserContainers?.timers as
    | {
        setTimeout?: (fn: () => void, ms?: number) => RefableTimer;
        clearTimeout?: (t: unknown) => void;
      }
    | undefined;

/**
 * Handle tracker wired into the process event loop. When running inside a
 * process worker, `__browserContainers.timers` is the loop-backed tracked
 * timers API (node-timers.ts → event-loop.ts LoopHandles): an open socket
 * acquires a far-future timer handle so `loop.hasRefed()` stays true and the
 * process does not exit while a ref'd connection or listener is live.
 * `ref()`/`unref()` propagate to that handle; `release()` clears it.
 *
 * Outside a worker (or before `timers` is installed) it falls back to a local
 * refcount — still observable via `tracker.hasRefed()`.
 */
export const createNetHandleTracker = (): NetHandleTracker => {
  const handles = new Set<{ refed: boolean }>();
  return {
    acquire(): NetLoopHandle {
      const timers = workerTimers();
      const timer = timers?.setTimeout?.(() => {}, 0x7fffffff);
      const rec = { refed: true };
      handles.add(rec);
      let released = false;
      return {
        ref() {
          rec.refed = true;
          timer?.ref?.();
        },
        unref() {
          rec.refed = false;
          timer?.unref?.();
        },
        hasRef: () => !released && rec.refed,
        release() {
          if (released) return;
          released = true;
          handles.delete(rec);
          if (timer) timers?.clearTimeout?.(timer);
        },
      };
    },
    hasRefed: () => {
      for (const h of handles) if (h.refed) return true;
      return false;
    },
  };
};

/** Shared tracker for sockets/servers constructed without an explicit one. */
const defaultHandleTracker = createNetHandleTracker();

// ---------------------------------------------------------------------------
// net.Socket — a stream.Duplex over a ByteTransport connection
// ---------------------------------------------------------------------------

export interface SocketOptions extends NetConnectOptions {
  allowHalfOpen?: boolean;
  /** stream.Writable/Readable options Node's Socket forwards through. */
  highWaterMark?: number;
  readableHighWaterMark?: number;
  writableHighWaterMark?: number;
}

export interface Socket extends InstanceType<typeof stream.Duplex> {
  readonly connecting: boolean;
  /**
   * Node: true between `connect()` and the 'connect' event, and again after
   * close/destroy. False once the connection is established.
   */
  readonly pending: boolean;
  readonly readyState: "opening" | "open" | "readOnly" | "writeOnly" | "closed";
  remoteAddress?: string;
  remotePort?: number;
  remoteFamily?: string;
  localAddress?: string;
  localPort?: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  connect(
    options: SocketOptions | number | string,
    hostOrCb?: string | (() => void),
    cb?: () => void,
  ): this;
  address(): { address: string; family?: string; port: number } | null;
  setTimeout(msec: number, callback?: () => void): this;
  setNoDelay(noDelay?: boolean): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  ref(): this;
  unref(): this;
  // Underscore-prefixed transport plumbing (Node-internal naming style;
  // internal state lives on the interface like the streams port's
  // `_readableState`/`_writableState`).
  _transport: ByteTransport;
  _options: SocketOptions;
  _tracker: NetHandleTracker;
  _connecting: boolean;
  _everConnected: boolean;
  _bytesRead: number;
  _bytesWritten: number;
  _reader?: ReadableStreamDefaultReader<Uint8Array>;
  _writer?: WritableStreamDefaultWriter<Uint8Array>;
  _writableStream?: WritableStream<Uint8Array>;
  _pendingWrites: PendingWrite[];
  _pendingFinal?: (err?: Error | null) => void;
  _pumping: boolean;
  _handle?: NetLoopHandle;
  _timeout?: ReturnType<typeof setTimeout>;
  _timeoutMsec: number;
  _noDelay: boolean;
  _keepAlive: boolean;
  _keepAliveDelay: number;
  _read(size: number): void;
  _final(cb: (err?: Error | null) => void): void;
  _attachTransport(
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
  ): void;
  _pump(): void;
  _flushPending(): void;
  _sendBytes(bytes: Uint8Array, cb: (err?: Error | null) => void): void;
  _closeWriter(cb: (err?: Error | null) => void): void;
  _refreshTimeout(): void;
  _clearTimeout(): void;
  _releaseHandle(): void;
}

export interface SocketCtor {
  new (transport?: ByteTransport, options?: SocketOptions): Socket;
  (transport?: ByteTransport, options?: SocketOptions): Socket;
  prototype: Socket;
  /** Wraps a server-side accepted connection. */
  fromAcceptedConnection(conn: AcceptedConnection, tracker?: NetHandleTracker): Socket;
}

const TEXT_ENCODER = new TextEncoder();

const toBytes = (chunk: unknown): Uint8Array =>
  chunk instanceof Uint8Array
    ? chunk
    : typeof chunk === "string"
      ? TEXT_ENCODER.encode(chunk)
      : new Uint8Array(chunk as ArrayBuffer);

const chunkByteLength = (chunk: unknown): number => {
  if (chunk == null) return 0;
  if (typeof chunk === "string") return TEXT_ENCODER.encode(chunk).byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return (chunk as { length?: number }).length ?? 0;
};

/**
 * `net.Socket` — a real `stream.Duplex`. `_read` pumps the transport's
 * ReadableStream (honouring stream backpressure: the pump stops when `push`
 * back-pressures or the socket is paused, and re-arms from `_read` on
 * `resume`/`data`-listener flow). `_write`/`_final` drive the transport's
 * WritableStream writer, so `write` backpressure, `drain`, `finish`,
 * `pipe`/`unpipe` and `writableEnded` all come from the streams port.
 */
export const Socket = function Socket(
  this: Socket,
  transport?: ByteTransport,
  options?: SocketOptions,
): Socket | void {
  if (!(this instanceof Socket)) {
    return new (Socket as unknown as { new (t?: ByteTransport, o?: SocketOptions): Socket })(
      transport,
      options,
    );
  }
  // Node's public signature is `new Socket(options?)` — when the first arg
  // is not a ByteTransport it is the options object, not a transport.
  if (transport !== undefined && typeof (transport as ByteTransport).connect !== "function") {
    options =
      options ??
      (typeof transport === "object" ? (transport as unknown as SocketOptions) : undefined);
    transport = undefined;
  }
  const opts = options ?? { port: 0 };
  DuplexCtor.call(this, {
    allowHalfOpen: opts.allowHalfOpen ?? false,
    ...(opts.highWaterMark !== undefined ? { highWaterMark: opts.highWaterMark } : {}),
    ...(opts.readableHighWaterMark !== undefined
      ? { readableHighWaterMark: opts.readableHighWaterMark }
      : {}),
    ...(opts.writableHighWaterMark !== undefined
      ? { writableHighWaterMark: opts.writableHighWaterMark }
      : {}),
  });

  const self = this as unknown as SocketInternal;
  self._transport = transport ?? defaultLoopback;
  self._options = opts;
  self._tracker = defaultHandleTracker;
  self._connecting = false;
  self._everConnected = false;
  self._bytesRead = 0;
  self._bytesWritten = 0;
  self._pendingWrites = [];
  self._pendingFinal = undefined;
  self._pumping = false;
  self._reader = undefined;
  self._writer = undefined;
  self._writableStream = undefined;
  self._handle = undefined;
  self._timeout = undefined;
  self._timeoutMsec = 0;
  self._noDelay = false;
  self._keepAlive = false;
  self._keepAliveDelay = 0;
  self.remoteAddress = undefined;
  self.remotePort = undefined;
  self.remoteFamily = undefined;
  self.localAddress = undefined;
  self.localPort = undefined;
} as unknown as SocketCtor;

// Referenced by the exported `Socket` interface — must be exported for
// declaration emit (private names in public types fail `declaration: true`).
export interface PendingWrite {
  bytes: Uint8Array;
  cb: (err?: Error | null) => void;
}

type SocketInternal = Socket;

Object.setPrototypeOf(Socket.prototype, DuplexCtor.prototype);
Object.setPrototypeOf(Socket, DuplexCtor);

Socket.fromAcceptedConnection = (conn: AcceptedConnection, tracker?: NetHandleTracker): Socket => {
  const socket = new Socket(undefined, {
    port: conn.remotePort,
    host: conn.remoteAddress,
    allowHalfOpen: true,
  }) as SocketInternal;
  socket._tracker = tracker ?? defaultHandleTracker;
  socket._handle = socket._tracker.acquire();
  socket._everConnected = true;
  socket.remoteAddress = conn.remoteAddress;
  socket.remotePort = conn.remotePort;
  socket.remoteFamily = `IPv${isIP(conn.remoteAddress) || 4}`;
  socket._attachTransport(conn.readable, conn.writable);
  conn.onError = (err) => socket.destroy(err);
  return socket;
};

Object.defineProperties(Socket.prototype, {
  connecting: {
    get(this: SocketInternal) {
      return this._connecting;
    },
    configurable: true,
  },
  bytesRead: {
    get(this: SocketInternal) {
      return this._bytesRead;
    },
    configurable: true,
  },
  bytesWritten: {
    get(this: SocketInternal) {
      // Node: dispatched bytes + the in-flight chunk + everything still in
      // the writable buffer (lib/net.js bytesWritten getter). Chunks handed
      // to _write but queued behind a pending connect live in _pendingWrites
      // and surface through the stream state's `writing`/`writelen`.
      let bytes = this._bytesWritten;
      const w = this._writableState;
      if (w) {
        if (w.writing) bytes += w.writelen;
        for (let i = w.bufferedIndex; i < w.buffered.length; i++) {
          bytes += chunkByteLength(w.buffered[i]?.chunk);
        }
      }
      return bytes;
    },
    configurable: true,
  },
  pending: {
    get(this: SocketInternal) {
      return this._connecting || !this._everConnected || this.destroyed;
    },
    configurable: true,
  },
  readyState: {
    get(this: SocketInternal) {
      if (this._connecting) return "opening";
      if (this.destroyed || (this.readableEnded && this.writableEnded)) return "closed";
      if (this.readableEnded) return "writeOnly";
      if (this.writableEnded) return "readOnly";
      return this._writableStream || this._connecting ? "open" : "closed";
    },
    configurable: true,
  },
});

Socket.prototype.connect = function connect(
  this: SocketInternal,
  options: SocketOptions | number | string,
  hostOrCb?: string | (() => void),
  cb?: () => void,
): Socket {
  const self = this;
  if (self.destroyed) {
    throw makeError("ERR_STREAM_DESTROYED", "Cannot call connect after a stream was destroyed");
  }
  if (self._connecting || self._writableStream) {
    throw makeError("ERR_SOCKET_ALREADY_CONNECTED", "Socket is already connected or connecting");
  }

  let host = self._options.host;
  let port = self._options.port;
  const onConnect = typeof hostOrCb === "function" ? hostOrCb : cb;

  if (typeof options === "number") {
    port = validatePort(options);
    if (typeof hostOrCb === "string") host = hostOrCb;
  } else if (typeof options === "string") {
    const idx = options.lastIndexOf(":");
    if (idx > 0) {
      host = options.slice(0, idx) || host;
      port = validatePort(Number.parseInt(options.slice(idx + 1), 10));
    } else {
      throw makeError(
        "ERR_SOCKET_BAD_PORT",
        "IPC socket paths are not supported in the browser; pass { port, host }",
      );
    }
  } else if (options && typeof options === "object") {
    port = validatePort(options.port);
    host = options.host ?? host;
  } else {
    throw invalidArgType("options", "object", options);
  }

  self._options = { ...self._options, host, port };
  self.remoteAddress = host;
  self.remotePort = port;
  self.remoteFamily = `IPv${isIP(host ?? "") || 4}`;
  if (onConnect) self.once("connect", onConnect);

  self._connecting = true;
  self._handle = self._tracker.acquire();

  // Synchronous transport failures (NoopTransport's documented error) throw
  // through, matching `net.connect` throwing on invalid setup. Async
  // rejections surface as coded 'error' events like Node's errno exceptions.
  let connectPromise: ReturnType<ByteTransport["connect"]>;
  try {
    connectPromise = self._transport.connect(
      self._options,
      (msg) => self.emit("control", msg),
      (err) => self.destroy(err instanceof Error ? err : new Error(String(err))),
    );
  } catch (err) {
    self._connecting = false;
    self._releaseHandle();
    throw err;
  }

  connectPromise.then(
    ({ readable, writable, remoteAddress, remotePort, localAddress, localPort }) => {
      if (self.destroyed) return;
      self._connecting = false;
      self._everConnected = true;
      if (remoteAddress !== undefined) self.remoteAddress = remoteAddress;
      if (remotePort !== undefined) self.remotePort = remotePort;
      self.localAddress = localAddress;
      self.localPort = localPort;
      self._attachTransport(readable, writable);
      self._flushPending();
      self.emit("connect");
      self._refreshTimeout();
    },
    (err) => {
      self._connecting = false;
      self._releaseHandle();
      const e = err instanceof Error ? err : new Error(String(err));
      const code = (e as { code?: string }).code;
      const mapped = code !== undefined ? e : errnoException("ECONNREFUSED", "connect", host, port);
      // destroy(err) emits 'error' (via the streams destroy path) then
      // 'close' — the Node ordering for a failed connect.
      self.destroy(mapped);
    },
  );
  return self;
} as Socket["connect"];

Socket.prototype._attachTransport = function _attachTransport(
  this: SocketInternal,
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): void {
  const self = this;
  self._writableStream = writable;
  self._reader = readable.getReader();
  // Data may already be buffered in the transport stream — start pulling; the
  // pump self-limits on stream backpressure and when paused.
  self._pump();
};

Socket.prototype._flushPending = function _flushPending(this: SocketInternal): void {
  const self = this;
  const pending = self._pendingWrites;
  self._pendingWrites = [];
  for (const { bytes, cb } of pending) {
    self._sendBytes(bytes, cb);
  }
  const final = self._pendingFinal;
  self._pendingFinal = undefined;
  if (final) self._closeWriter(final);
};

Socket.prototype._sendBytes = function _sendBytes(
  this: SocketInternal,
  bytes: Uint8Array,
  cb: (err?: Error | null) => void,
): void {
  const self = this;
  if (!self._writableStream) {
    cb(errnoException("EPIPE", "write", self.remoteAddress, self.remotePort));
    return;
  }
  if (!self._writer) {
    try {
      self._writer = self._writableStream.getWriter();
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }
  self._writer.write(bytes).then(
    () => {
      // Completed writes only — the bytesWritten getter adds the in-flight
      // chunk (state.writelen) and the not-yet-_write buffered tail, matching
      // Node's dispatched + pendingData + writableBuffer sum.
      self._bytesWritten += bytes.byteLength;
      self._refreshTimeout();
      cb();
    },
    (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if ((e as { code?: string }).code === undefined) {
        const coded = errnoException("EPIPE", "write", self.remoteAddress, self.remotePort);
        coded.cause = e;
        cb(coded);
      } else {
        cb(e);
      }
    },
  );
};

Socket.prototype._closeWriter = function _closeWriter(
  this: SocketInternal,
  cb: (err?: Error | null) => void,
): void {
  const self = this;
  if (!self._writableStream) {
    cb();
    return;
  }
  try {
    const writer = self._writer ?? self._writableStream.getWriter();
    self._writer = writer;
    writer.close().then(
      () => cb(),
      (err) => cb(err instanceof Error ? err : new Error(String(err))),
    );
  } catch (err) {
    cb(err instanceof Error ? err : new Error(String(err)));
  }
};

// --- stream.Duplex hooks -------------------------------------------------

Socket.prototype._read = function _read(this: SocketInternal, _size: number): void {
  this._pump();
};

/**
 * Pulls from the transport ReadableStream while the Node stream wants data.
 * Stops on backpressure (`push` → false) or when paused; the next `_read`
 * (triggered by `resume()`, a new `data` listener, or buffer drain) re-arms.
 */
Socket.prototype._pump = function _pump(this: SocketInternal): void {
  const self = this;
  if (self._pumping || !self._reader || self.destroyed) return;
  self._pumping = true;
  void (async () => {
    try {
      for (;;) {
        const reader = self._reader;
        if (!reader || self.destroyed) break;
        const { done, value } = await reader.read();
        if (self.destroyed) break;
        if (done) {
          self.push(null);
          if (!self.allowHalfOpen && !self.writableEnded) {
            self.end();
          }
          break;
        }
        self._bytesRead += value.byteLength;
        self._refreshTimeout();
        if (self.isPaused()) {
          // Parked mid-read: hand the chunk back to the readable buffer; the
          // next `_read` (from `resume()`/`read()`) re-arms the pump.
          self.unshift(value);
          break;
        }
        if (!self.push(value)) break;
      }
    } catch (err) {
      if (!self.destroyed) {
        const e = err instanceof Error ? err : new Error(String(err));
        self.destroy((e as { code?: string }).code ? e : errnoException("ECONNRESET", "read"));
      }
    } finally {
      self._pumping = false;
    }
  })();
};

Socket.prototype._write = function _write(
  this: SocketInternal,
  chunk: unknown,
  _encoding: string,
  cb: (err?: Error | null) => void,
): void {
  const self = this;
  const bytes = toBytes(chunk);
  if (!self._writableStream) {
    // Node queues writes issued while connecting; flush in order once the
    // transport streams arrive, or fail them if connect fails first.
    if (self._connecting) {
      self._pendingWrites.push({ bytes, cb });
      return;
    }
    cb(errnoException("EPIPE", "write", self.remoteAddress, self.remotePort));
    return;
  }
  self._sendBytes(bytes, cb);
};

Socket.prototype._final = function _final(
  this: SocketInternal,
  cb: (err?: Error | null) => void,
): void {
  const self = this;
  if (self._connecting) {
    self._pendingFinal = cb;
    return;
  }
  self._closeWriter(cb);
};

Socket.prototype._destroy = function _destroy(
  this: SocketInternal,
  err: Error | null,
  cb: (err?: Error | null) => void,
): void {
  const self = this;
  self._connecting = false;
  self._clearTimeout();
  self._releaseHandle();
  // Fail writes still queued behind a pending connect.
  const pending = self._pendingWrites;
  self._pendingWrites = [];
  const writeErr = err ?? errnoException("EPIPE", "write");
  for (const { cb: wcb } of pending) wcb(writeErr);
  const pendingFinal = self._pendingFinal;
  self._pendingFinal = undefined;
  pendingFinal?.(writeErr);

  self._reader?.cancel().catch(() => {});
  self._reader = undefined;
  if (self._writableStream) {
    const writer = self._writer;
    self._writer = undefined;
    try {
      (writer ?? self._writableStream.getWriter()).abort().catch(() => {});
    } catch {
      /* stream already errored/closed */
    }
    self._writableStream = undefined;
  }
  cb(err);
};

// --- Socket lifecycle / liveness -----------------------------------------

Socket.prototype.address = function address(
  this: SocketInternal,
): { address: string; family?: string; port: number } | null {
  if (this.localAddress === undefined || this.localPort === undefined) return null;
  return { address: this.localAddress, family: this.remoteFamily, port: this.localPort };
};

Socket.prototype._releaseHandle = function _releaseHandle(this: SocketInternal): void {
  this._handle?.release();
  this._handle = undefined;
};

Socket.prototype.ref = function ref(this: SocketInternal): Socket {
  this._handle?.ref();
  return this;
} as Socket["ref"];

Socket.prototype.unref = function unref(this: SocketInternal): Socket {
  this._handle?.unref();
  return this;
} as Socket["unref"];

Socket.prototype.setNoDelay = function setNoDelay(this: SocketInternal, noDelay = true): Socket {
  // TCP_NODELAY is applied relay-side; tracked for shape parity.
  this._noDelay = Boolean(noDelay);
  return this;
} as Socket["setNoDelay"];

Socket.prototype.setKeepAlive = function setKeepAlive(
  this: SocketInternal,
  enable = false,
  initialDelay = 0,
): Socket {
  this._keepAlive = Boolean(enable);
  this._keepAliveDelay = initialDelay;
  return this;
} as Socket["setKeepAlive"];

Socket.prototype._clearTimeout = function _clearTimeout(this: SocketInternal): void {
  if (this._timeout !== undefined) {
    clearTimeout(this._timeout);
    this._timeout = undefined;
  }
};

Socket.prototype._refreshTimeout = function _refreshTimeout(this: SocketInternal): void {
  const self = this;
  self._clearTimeout();
  if (self._timeoutMsec > 0 && !self.destroyed) {
    self._timeout = setTimeout(() => {
      self._timeout = undefined;
      self.emit("timeout");
    }, self._timeoutMsec);
  }
};

Socket.prototype.setTimeout = function setTimeout(
  this: SocketInternal,
  msec: number,
  callback?: () => void,
): Socket {
  const self = this;
  if (msec !== undefined && (typeof msec !== "number" || msec < 0)) {
    throw outOfRange("msecs", ">= 0", msec);
  }
  self._timeoutMsec = msec;
  if (callback) self.once("timeout", callback);
  self._refreshTimeout();
  return self;
} as Socket["setTimeout"];

// --- isIP / isIPv4 / isIPv6 (ported from Node's lib/internal/net.js) -------

const v4Seg = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])";
const IPv4Reg = new RegExp(`^(${v4Seg}[.]){3}${v4Seg}$`);
const IPv6Seg = "(?:[0-9a-fA-F]{1,4})";
const IPv6Reg = new RegExp(
  "^(" +
    `(?:${IPv6Seg}:){7}(?:${IPv6Seg}|:)|` +
    `(?:${IPv6Seg}:){1,7}:|` +
    `(?:${IPv6Seg}:){1,6}:${IPv6Seg}|` +
    `(?:${IPv6Seg}:){1,5}(?::${IPv6Seg}){1,2}|` +
    `(?:${IPv6Seg}:){1,4}(?::${IPv6Seg}){1,3}|` +
    `(?:${IPv6Seg}:){1,3}(?::${IPv6Seg}){1,4}|` +
    `(?:${IPv6Seg}:){1,2}(?::${IPv6Seg}){1,5}|` +
    `${IPv6Seg}:(?:(?::${IPv6Seg}){1,6})|` +
    `:(?:(?::${IPv6Seg}){1,7}|:)|` +
    `fe80:(?::${IPv6Seg}){0,4}%[0-9a-zA-Z]{1,}|` +
    `::(?:ffff(?::0{1,4}){0,1}:){0,1}${IPv4Reg.source.slice(1, -1)}|` +
    `(?:${IPv6Seg}:){1,4}:${IPv4Reg.source.slice(1, -1)}` +
    ")$",
);

export const isIPv4 = (input: string): boolean => IPv4Reg.test(input);
export const isIPv6 = (input: string): boolean => IPv6Reg.test(input);
export const isIP = (input: string): number => {
  if (typeof input !== "string" || input.length === 0) return 0;
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
};

// ---------------------------------------------------------------------------
// net.Server
// ---------------------------------------------------------------------------

export interface ServerAddress {
  port: number;
  address: string;
  family: string;
}

export interface ServerListenOptions {
  port?: number;
  host?: string;
  backlog?: number;
}

export interface Server extends InstanceType<typeof events> {
  readonly listening: boolean;
  maxConnections: number;
  listen(port?: number, host?: string, backlog?: number, callback?: () => void): this;
  listen(port?: number, host?: string, callback?: () => void): this;
  listen(options: ServerListenOptions, callback?: () => void): this;
  listen(callback?: () => void): this;
  close(callback?: (err?: Error) => void): this;
  address(): ServerAddress | string | null;
  getConnections(callback: (err: Error | null, count: number) => void): this;
  ref(): this;
  unref(): this;
  _transport: ByteTransport;
  _tracker: NetHandleTracker;
  _allowHalfOpen: boolean;
  _listener?: { port: number; host: string; close: () => Promise<void> };
  _connections: Set<Socket>;
  _listening: boolean;
  _handle?: NetLoopHandle;
  _releaseHandle(): void;
}

export interface ServerCtor {
  new (
    transport?: ByteTransport,
    options?: { allowHalfOpen?: boolean },
    connectionListener?: (socket: Socket) => void,
  ): Server;
  (
    transport?: ByteTransport,
    options?: { allowHalfOpen?: boolean },
    connectionListener?: (socket: Socket) => void,
  ): Server;
  prototype: Server;
}

/**
 * `net.Server` — an EventEmitter (callable without `new`, like Node's
 * function-style `Server`). `listen` returns the server synchronously;
 * `listening`/`connection`/`close`/`error` arrive as events. `ref`/`unref`
 * toggle the loop handle acquired while listening.
 */
export const Server = function Server(
  this: Server,
  transport?: ByteTransport,
  options?: { allowHalfOpen?: boolean; backlog?: number },
  connectionListener?: (socket: Socket) => void,
): Server | void {
  if (!(this instanceof Server)) {
    return new (Server as unknown as {
      new (
        t?: ByteTransport,
        o?: { allowHalfOpen?: boolean; backlog?: number },
        c?: (socket: Socket) => void,
      ): Server;
    })(transport, options, connectionListener);
  }
  // Node's public signature is `new Server(options?, connectionListener?)` —
  // the leading transport arg is this shim's extension. When it is not a
  // ByteTransport (a listener function or a plain options object) the args
  // shift back to the Node shape.
  if (
    transport !== undefined &&
    (typeof (transport as ByteTransport).listen !== "function" ||
      typeof (transport as ByteTransport).connect !== "function")
  ) {
    if (typeof transport === "function") {
      connectionListener = transport as unknown as (socket: Socket) => void;
    } else {
      if (typeof options === "function") {
        connectionListener = options as unknown as (socket: Socket) => void;
      }
      options = transport as { allowHalfOpen?: boolean; backlog?: number };
    }
    transport = undefined;
  }
  // `events` is a class, not a function-style ctor — `EventEmitter.call(this)`
  // throws "class constructor cannot be invoked without 'new'". Node's legacy
  // `EventEmitter.init(this)` performs the same `_events`/`_eventsCount`
  // initialization the stream port uses in `Stream`.
  events.init(this);
  const self = this as unknown as ServerInternal;
  self._transport = transport ?? defaultLoopback;
  self._tracker = defaultHandleTracker;
  self._allowHalfOpen = options?.allowHalfOpen ?? false;
  self._listener = undefined;
  self._connections = new Set();
  self._listening = false;
  self._handle = undefined;
  self.maxConnections = options?.backlog ?? 511;
  if (connectionListener) self.on("connection", connectionListener);
} as unknown as ServerCtor;

type ServerInternal = Server;

Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Server, EventEmitter);

Object.defineProperty(Server.prototype, "listening", {
  get(this: ServerInternal) {
    return this._listening;
  },
  configurable: true,
});

const normalizeListenArgs = (
  args: unknown[],
): { port: number; host: string; backlog: number | undefined; cb?: () => void } => {
  let port = 0;
  let host = "0.0.0.0";
  let backlog: number | undefined;
  let cb: (() => void) | undefined;

  const [a, b, c, d] = args;
  if (typeof a === "function") {
    cb = a as () => void;
  } else if (a !== null && typeof a === "object") {
    const opts = a as ServerListenOptions;
    port = opts.port === undefined ? 0 : validatePort(opts.port, "port", true);
    host = opts.host ?? host;
    backlog = opts.backlog;
    if (typeof b === "function") cb = b as () => void;
  } else if (typeof a === "number" || a === undefined) {
    if (a !== undefined) port = validatePort(a, "port", true);
    if (typeof b === "function") {
      cb = b as () => void;
    } else {
      if (b !== undefined) {
        if (typeof b !== "string") throw invalidArgType("host", "string", b);
        host = b;
      }
      if (typeof c === "function") {
        cb = c as () => void;
      } else {
        if (c !== undefined) {
          if (typeof c !== "number" || c < 0) throw outOfRange("backlog", ">= 0", c);
          backlog = c;
        }
        if (typeof d === "function") cb = d as () => void;
      }
    }
  } else {
    throw invalidArgType("options", "object", a);
  }
  return { port, host, backlog, cb };
};

Server.prototype.listen = function listen(this: ServerInternal, ...args: unknown[]): Server {
  const self = this;
  const { port, host, backlog, cb } = normalizeListenArgs(args);
  if (self._listening) {
    const err = makeError("ERR_SERVER_ALREADY_LISTEN", "Listen method called more than once");
    queueMicrotask(() => self.emit("error", err));
    return self;
  }
  if (cb) self.once("listening", cb);
  if (backlog !== undefined) self.maxConnections = backlog;
  self._handle = self._tracker.acquire();

  let listenPromise: Promise<{ port: number; host: string; close: () => Promise<void> }>;
  try {
    listenPromise = self._transport.listen(
      port,
      host,
      (conn) => {
        const socket = Socket.fromAcceptedConnection(conn, self._tracker);
        socket.allowHalfOpen = self._allowHalfOpen;
        self._connections.add(socket);
        socket.once("close", () => self._connections.delete(socket));
        self.emit("connection", socket);
      },
      (msg) => self.emit("control", msg),
    );
  } catch (err) {
    // NoopTransport's documented error — synchronous, like Node's EINVAL.
    self._handle?.release();
    self._handle = undefined;
    throw err;
  }

  listenPromise.then(
    (handle) => {
      self._listener = handle;
      self._listening = true;
      self.emit("listening");
    },
    (err) => {
      self._releaseHandle();
      const e = err instanceof Error ? err : new Error(String(err));
      const mapped = (e as { code?: string }).code
        ? e
        : errnoException("EADDRINUSE", "listen", host, port);
      self.emit("error", mapped);
    },
  );
  return self;
} as Server["listen"];

Server.prototype._releaseHandle = function _releaseHandle(this: ServerInternal): void {
  this._handle?.release();
  this._handle = undefined;
};

Server.prototype.address = function address(this: ServerInternal): ServerAddress | null {
  if (!this._listening || !this._listener) return null;
  return {
    port: this._listener.port,
    address: this._listener.host,
    family: `IPv${isIP(this._listener.host) || 4}`,
  };
};

Server.prototype.getConnections = function getConnections(
  this: ServerInternal,
  cb: (err: Error | null, count: number) => void,
): Server {
  cb(null, this._connections.size);
  return this;
} as Server["getConnections"];

Server.prototype.close = function close(
  this: ServerInternal,
  callback?: (err?: Error) => void,
): Server {
  const self = this;
  if (!self._listener) {
    const err = makeError("ERR_SERVER_NOT_RUNNING", "Server is not running.");
    if (callback) {
      queueMicrotask(() => callback(err));
    } else {
      queueMicrotask(() => self.emit("error", err));
    }
    return self;
  }
  if (callback) self.once("close", () => callback());
  const listener = self._listener;
  self._listener = undefined;
  self._listening = false;
  self._releaseHandle();
  void listener.close().then(
    () => self.emit("close"),
    (err) => {
      self.emit("error", err instanceof Error ? err : new Error(String(err)));
      self.emit("close");
    },
  );
  return self;
} as Server["close"];

Server.prototype.ref = function ref(this: ServerInternal): Server {
  this._handle?.ref();
  return this;
} as Server["ref"];

Server.prototype.unref = function unref(this: ServerInternal): Server {
  this._handle?.unref();
  return this;
} as Server["unref"];

// ---------------------------------------------------------------------------
// Shim assembly
// ---------------------------------------------------------------------------

export interface NetShimOptions {
  tcpRelay?: { url: string };
  onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
  /** Loop-handle tracker override (tests / custom liveness plumbing). */
  handleTracker?: NetHandleTracker;
  /** Transport override (tests / alternate relays). */
  transport?: ByteTransport;
}

const normalizeConnectArgs = (args: unknown[]): { options: NetConnectOptions; cb?: () => void } => {
  const [a, b, c] = args;
  if (typeof a === "number") {
    return {
      options: { port: validatePort(a), host: typeof b === "string" ? b : undefined },
      cb: (typeof b === "function" ? b : c) as (() => void) | undefined,
    };
  }
  if (a !== null && typeof a === "object") {
    const opts = a as NetConnectOptions;
    return {
      options: { port: validatePort(opts.port), host: opts.host },
      cb: typeof b === "function" ? (b as () => void) : undefined,
    };
  }
  throw invalidArgType("options", "object", a);
};

export const createNetShim = (_sandbox?: unknown, options?: NetShimOptions) => {
  // Default: in-process loopback. `net.connect`/`net.Server.listen` pair
  // inside the realm (ECONNREFUSED/EADDRINUSE intact); a configured
  // `tcpRelay` or explicit `transport` still wins for real egress.
  const transport: ByteTransport =
    options?.transport ??
    (options?.tcpRelay?.url ? new WebSocketTransport(options.tcpRelay.url) : defaultLoopback);
  const tracker = options?.handleTracker ?? defaultHandleTracker;

  const bindTracker = <T extends { _tracker?: NetHandleTracker }>(obj: T): T => {
    (obj as { _tracker: NetHandleTracker })._tracker = tracker;
    return obj;
  };

  const connect = (...args: unknown[]): Socket => {
    const { options: connectOptions, cb } = normalizeConnectArgs(args);
    const socket = bindTracker(new Socket(transport) as SocketInternal);
    if (cb) socket.once("connect", cb);
    socket.once("error", (e: Error) => {
      // Matches previous behaviour: unhandled socket errors are logged, not
      // thrown, for the default registry path.
      // eslint-disable-next-line no-console
      console.error("net.connect error:", e);
    });
    socket.connect(connectOptions);
    return socket;
  };

  return {
    createServer: (
      optionsOrListener?: { allowHalfOpen?: boolean } | ((socket: Socket) => void),
      connectionListener?: (socket: Socket) => void,
    ) => {
      const opts = typeof optionsOrListener === "object" ? optionsOrListener : undefined;
      const listener =
        typeof optionsOrListener === "function" ? optionsOrListener : connectionListener;
      return bindTracker(new Server(transport, opts, listener) as ServerInternal);
    },
    connect,
    createConnection: connect,
    Server,
    Socket,
    // Node's legacy alias: `net.Stream` is the Socket constructor.
    Stream: Socket,
    isIP,
    isIPv4,
    isIPv6,
  };
};

export type { StreamSocket };
