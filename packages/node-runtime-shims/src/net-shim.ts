import type { NetConnectOptions, StreamSocket } from "./live.js";

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
  }>;
  listen(
    port: number,
    host: string,
    onConnection: (conn: AcceptedConnection) => void,
    onControl: (msg: object) => void,
  ): Promise<{ port: number; host: string; close: () => Promise<void> }>;
}

export class NoopTransport implements ByteTransport {
  connect(
    _options?: NetConnectOptions,
    _onControl?: (msg: object) => void,
    _onError?: (err: Error) => void,
  ): Promise<never> {
    throw new Error(
      "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage",
    );
  }

  listen(
    _port: number,
    _host: string,
    _onConnection: (conn: AcceptedConnection) => void,
    _onControl: (msg: object) => void,
  ): Promise<never> {
    throw new Error(
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage",
    );
  }
}

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
              tls: options.tls,
            }),
          ),
        );
      };

      ws.onerror = (event) => {
        const err = new Error(`WebSocket error: ${event.type}`);
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

      const cleanup = () => {
        for (const { readableController } of connections.values()) {
          readableController.close();
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
        const err = new Error(`WebSocket error: ${event.type}`);
        if (!listening) {
          reject(err);
        }
        for (const [id, conn] of connections) {
          conn.accepted.onError?.(err);
          conn.readableController.close();
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
            conn.readableController.close();
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
          if (conn?.readableController) {
            conn.readableController.enqueue(payload);
          }
        } else if (type === FRAME_TYPE.CLOSE) {
          const conn = connections.get(connectionId);
          if (conn?.readableController) {
            conn.readableController.close();
          }
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
          if (conn?.readableController) {
            conn.readableController.close();
          }
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

export class WebTransportTransport implements ByteTransport {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(
    options: NetConnectOptions,
    _onControl: (msg: object) => void,
    _onError?: (err: Error) => void,
  ): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }> {
    const wt = new WebTransport(this.url);
    await wt.ready;

    const bidi = await wt.createBidirectionalStream();
    const writer = bidi.writable.getWriter();
    const encoder = new TextEncoder();

    const msg = JSON.stringify({
      type: "connect",
      host: options.host ?? "localhost",
      port: options.port,
      tls: options.tls,
    });
    await writer.write(encoder.encode(msg));

    const reader = bidi.readable.getReader();
    const { value: firstChunk } = await reader.read();
    if (!firstChunk) throw new Error("WebTransport: empty connected response");
    const response = JSON.parse(new TextDecoder().decode(firstChunk));
    if (response.type !== "connected") {
      throw new Error(`WebTransport: expected connected, got ${response.type}`);
    }
    reader.releaseLock();

    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      abort: () => writer.abort(),
    });

    return { readable: bidi.readable, writable };
  }

  async listen(
    port: number,
    host: string,
    onConnection: (conn: AcceptedConnection) => void,
    _onControl: (msg: object) => void,
  ): Promise<{ port: number; host: string; close: () => Promise<void> }> {
    const wt = new WebTransport(this.url);
    await wt.ready;

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const datagramWriter = wt.datagrams.writable.getWriter();
    await datagramWriter.write(encoder.encode(JSON.stringify({ type: "listen", port, host })));

    const datagramReader = wt.datagrams.readable.getReader();
    const { value: listeningData } = await datagramReader.read();
    if (!listeningData) throw new Error("WebTransport: empty listening response");
    const listeningMsg = JSON.parse(decoder.decode(listeningData));
    if (listeningMsg.type !== "listening") {
      throw new Error(`WebTransport: expected listening, got ${listeningMsg.type}`);
    }

    const streamReader = wt.incomingBidirectionalStreams.getReader();
    const acceptLoop = (async () => {
      while (true) {
        const { done, value: bidi } = await streamReader.read();
        if (done) break;
        const connReader = bidi.readable.getReader();
        const { value: metaChunk } = await connReader.read();
        if (!metaChunk) continue;
        const meta = JSON.parse(decoder.decode(metaChunk));
        connReader.releaseLock();
        onConnection({
          connectionId:
            globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10),
          readable: bidi.readable,
          writable: bidi.writable,
          remoteAddress: meta.remoteAddress ?? "unknown",
          remotePort: meta.remotePort ?? 0,
        });
      }
    })();
    acceptLoop.catch(() => {});

    return {
      port: listeningMsg.port,
      host: listeningMsg.host,
      close: async () => {
        try {
          await datagramWriter.write(encoder.encode(JSON.stringify({ type: "unlisten" })));
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1000));
          const ack = datagramReader.read().then(({ value }) => {
            if (value) {
              const msg = JSON.parse(decoder.decode(value));
              if (msg.type === "unlistened") return;
            }
          });
          await Promise.race([ack, timeout]);
        } catch {
          // best-effort
        }
        datagramWriter.releaseLock();
        datagramReader.releaseLock();
        wt.close();
      },
    };
  }
}

export class Socket implements StreamSocket {
  private transport: ByteTransport;
  private options: NetConnectOptions;
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();
  private readable?: ReadableStream<Uint8Array>;
  private writable?: WritableStream<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private _destroyed = false;
  private _connecting = false;
  private _reading = false;

  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly localAddress?: string;
  readonly localPort?: number;

  constructor(transport?: ByteTransport, options?: NetConnectOptions) {
    this.transport = transport ?? new NoopTransport();
    this.options = options ?? { port: 0 };
    this.remoteAddress = this.options.host;
    this.remotePort = this.options.port;
  }

  static fromAcceptedConnection(conn: AcceptedConnection): Socket {
    const socket = new Socket(undefined, { port: conn.remotePort, host: conn.remoteAddress });
    socket.readable = conn.readable;
    socket.writable = conn.writable;
    conn.onError = (err) => socket.emit("error", err);
    return socket;
  }

  connect(target?: string): void {
    if (this._connecting) return;
    this._connecting = true;
    if (target) {
      const [host, portStr] = target.split(":");
      this.options = {
        ...this.options,
        host: host || this.options.host,
        port: portStr ? parseInt(portStr, 10) : this.options.port,
      };
    }
    try {
      const connectPromise = this.transport.connect(
        this.options,
        (msg) => this.emit("control", msg),
        (err) => this.emit("error", err),
      );
      connectPromise.then(
        ({ readable, writable }) => {
          this.readable = readable;
          this.writable = writable;
          this._connecting = false;
          if (this.listeners.get("data")?.size) {
            this.startReading();
          }
          this.emit("connect");
        },
        (err) => {
          this._connecting = false;
          this.emit("error", err);
        },
      );
    } catch (err) {
      this._connecting = false;
      this.emit("error", err);
      throw err;
    }
  }

  write(chunk: Uint8Array | string): boolean {
    if (this._destroyed || !this.writable) return false;
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    if (!this.writer) {
      this.writer = this.writable.getWriter();
    }
    this.writer.write(bytes).catch(() => {});
    return true;
  }

  end(): this {
    if (!this.writable) return this;
    if (!this.writer) {
      this.writer = this.writable.getWriter();
    }
    this.writer.close().catch(() => {});
    return this;
  }

  destroy(error?: Error): this {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.reader?.cancel().catch(() => {});
    if (this.writable) {
      const writer = this.writer ?? this.writable.getWriter();
      writer.abort().catch(() => {});
    }
    this.readable = undefined;
    this.writable = undefined;
    this.reader = undefined;
    this.writer = undefined;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    if (event === "data" && this.readable && !this._reading) {
      this.startReading();
    }
    return this;
  }

  setTimeout(_msec: number, _callback?: () => void): this {
    return this;
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private startReading(): void {
    if (!this.readable || this._reading) return;
    this._reading = true;
    this.reader = this.readable.getReader();
    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await this.reader!.read();
          if (done) break;
          this.emit("data", value);
        }
      } catch (err) {
        this.emit("error", err);
      } finally {
        this._reading = false;
        this.reader = undefined;
        this.emit("end");
        this.emit("close");
      }
    };
    readLoop();
  }
}

export class Server {
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map();
  private transport: ByteTransport;
  private listenerHandle?: { port: number; host: string; close: () => Promise<void> };
  private addressInfo?: { port: number; host: string; family: string };
  private _listening = false;
  private _closed = false;

  constructor(transport?: ByteTransport, connectionListener?: (socket: Socket) => void) {
    this.transport = transport ?? new NoopTransport();
    if (connectionListener) this.on("connection", connectionListener);
  }

  async listen(port: number, host?: string, callback?: () => void): Promise<this> {
    this.listenerHandle = await this.transport.listen(
      port,
      host ?? "0.0.0.0",
      (conn) => {
        const socket = Socket.fromAcceptedConnection(conn);
        this.emit("connection", socket);
      },
      (msg) => this.emit("control", msg),
    );
    this.addressInfo = {
      port: this.listenerHandle.port,
      host: this.listenerHandle.host,
      family: "IPv4",
    };
    this._listening = true;
    callback?.();
    this.emit("listening");
    return this;
  }

  address(): { port: number; host: string; family: string } | null {
    return this._listening ? this.addressInfo! : null;
  }

  async close(callback?: () => void): Promise<this> {
    if (this.listenerHandle) {
      await this.listenerHandle.close();
      this.listenerHandle = undefined;
    }
    this._closed = true;
    this._listening = false;
    callback?.();
    this.emit("close");
    return this;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  private emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export const createNetShim = (
  _sandbox?: unknown,
  options?: {
    tcpRelay?: { url: string; transport?: "ws" | "webtransport" };
    onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
  },
) => {
  let transport: ByteTransport;
  if (options?.tcpRelay?.transport === "webtransport") {
    transport = new WebTransportTransport(options.tcpRelay.url);
  } else {
    transport = options?.tcpRelay?.url
      ? new WebSocketTransport(options.tcpRelay.url)
      : new NoopTransport();
  }
  return {
    createServer: (connectionListener?: (socket: Socket) => void) =>
      new Server(transport, connectionListener),
    connect: (opts: NetConnectOptions, onConnect?: () => void): Socket => {
      const socket = new Socket(transport, opts);
      socket.on("connect", onConnect ?? (() => {}));
      socket.on("error", (e: Error) => {
        // eslint-disable-next-line no-console
        console.error("net.connect error:", e);
      });
      const target = `${opts.host ?? "localhost"}:${opts.port}`;
      socket.connect(target);
      return socket;
    },
    Server,
    Socket,
    isIP: (input: string): number => {
      if (!input || typeof input !== "string") return 0;
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) {
        const parts = input.split(".");
        if (parts.every((part) => parseInt(part, 10) <= 255)) return 4;
      }
      if (/^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(input)) return 6;
      return 0;
    },
  };
};
