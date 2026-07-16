import type { NetConnectOptions, StreamSocket } from "./live.js";

export interface AcceptedConnection {
  connectionId: string;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  remoteAddress: string;
  remotePort: number;
}

export interface ByteTransport {
  connect(
    options: NetConnectOptions,
    onControl: (msg: object) => void,
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
  connect(): Promise<never> {
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

      const cleanup = () => {
        readableController?.close();
        readableController = undefined;
      };

      ws.onopen = () => {
        ws.send(
          new TextEncoder().encode(
            JSON.stringify({
              type: "connect",
              host: options.host ?? "localhost",
              port: options.port,
              tls: options.tls,
            }),
          ),
        );
      };

      ws.onerror = (event) => {
        if (!resolved) {
          reject(new Error(`WebSocket error: ${event.type}`));
        }
        cleanup();
        ws.close();
      };

      ws.onclose = () => {
        cleanup();
      };

      ws.onmessage = (event) => {
        const data =
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "connected") {
          resolved = true;
          connectionId = msg.connectionId;
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
              const bytes = btoa(String.fromCharCode(...chunk));
              ws.send(
                new TextEncoder().encode(JSON.stringify({ type: "data", connectionId, bytes })),
              );
            },
            close() {
              if (connectionId && ws.readyState === WebSocket.OPEN) {
                ws.send(new TextEncoder().encode(JSON.stringify({ type: "close", connectionId })));
              }
              ws.close();
            },
            abort() {
              ws.close();
            },
          });
          resolve({ readable, writable });
        } else if (msg.type === "data") {
          if (readableController && msg.bytes) {
            const bytes = Uint8Array.from(atob(msg.bytes), (c) => c.charCodeAt(0));
            readableController.enqueue(bytes);
          }
        } else if (msg.type === "close") {
          cleanup();
        } else {
          onControl(msg);
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
      const connections = new Map<
        string,
        {
          readableController: ReadableStreamDefaultController<Uint8Array>;
          writable: WritableStream<Uint8Array>;
        }
      >();

      const cleanup = () => {
        for (const { readableController } of connections.values()) {
          readableController.close();
        }
        connections.clear();
      };

      ws.onopen = () => {
        ws.send(new TextEncoder().encode(JSON.stringify({ type: "listen", port, host })));
      };

      ws.onerror = (event) => {
        if (!listening) {
          reject(new Error(`WebSocket error: ${event.type}`));
        }
        cleanup();
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
        const data =
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data);
        if (msg.type === "listening") {
          listening = true;
          resolve({
            port: msg.port,
            host: msg.host,
            close: () =>
              new Promise((res) => {
                closeResolve = res;
                ws.send(new TextEncoder().encode(JSON.stringify({ type: "unlisten" })));
              }),
          });
        } else if (msg.type === "connection") {
          const connectionId = msg.connectionId;
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
              const bytes = btoa(String.fromCharCode(...chunk));
              ws.send(
                new TextEncoder().encode(JSON.stringify({ type: "data", connectionId, bytes })),
              );
            },
            close() {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(new TextEncoder().encode(JSON.stringify({ type: "close", connectionId })));
              }
            },
            abort() {},
          });
          connections.set(connectionId, { readableController, writable });
          onConnection({
            connectionId,
            readable,
            writable,
            remoteAddress: msg.remoteAddress,
            remotePort: msg.remotePort,
          });
        } else if (msg.type === "data") {
          const conn = connections.get(msg.connectionId);
          if (conn?.readableController && msg.bytes) {
            const bytes = Uint8Array.from(atob(msg.bytes), (c) => c.charCodeAt(0));
            conn.readableController.enqueue(bytes);
          }
        } else if (msg.type === "close") {
          const conn = connections.get(msg.connectionId);
          if (conn?.readableController) {
            conn.readableController.close();
          }
          connections.delete(msg.connectionId);
        } else if (msg.type === "unlistened") {
          cleanup();
          if (closeResolve) {
            closeResolve();
            closeResolve = undefined;
          }
          ws.close();
        } else {
          onControl(msg);
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
    socket.startReading();
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
      const connectPromise = this.transport.connect(this.options, (msg) =>
        this.emit("control", msg),
      );
      connectPromise.then(
        ({ readable, writable }) => {
          this.readable = readable;
          this.writable = writable;
          this._connecting = false;
          this.emit("connect");
          this.startReading();
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
    this.writer = undefined;
    return this;
  }

  destroy(error?: Error): this {
    if (this._destroyed) return this;
    this._destroyed = true;
    this.reader?.cancel().catch(() => {});
    this.writer?.abort().catch(() => {});
    this.readable = undefined;
    this.writable = undefined;
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
