import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Socket,
  Server,
  WebSocketTransport,
  WebTransportTransport,
  NoopTransport,
  createNetShim,
} from "./net-shim.js";
import type { AcceptedConnection } from "./net-shim.js";

const EXPECTED_CONNECT_ERROR =
  "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage";

let mockInstances: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  binaryType: string = "arraybuffer";
  onopen?: () => void;
  onerror?: (event: { type: string }) => void;
  onclose?: () => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  readyState: number = MockWebSocket.CONNECTING;
  /** Text frames sent (JSON control messages). */
  sent: string[] = [];
  /** Binary frames sent (data frames). */
  sentBinary: ArrayBuffer[] = [];

  constructor(url: string) {
    this.url = url;
    mockInstances.push(this);
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    if (typeof data === "string") {
      this.sent.push(data);
    } else {
      // TypedArray (Uint8Array) vs raw ArrayBuffer
      const buf = data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.sentBinary.push(buf as ArrayBuffer);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  /** Simulate a binary data frame from the relay: [type(1)][connId(8)][payload]. */
  simulateBinaryData(connectionIdHex: string, payload: string) {
    const buf = Buffer.alloc(9 + payload.length);
    buf[0] = 0x03;
    // Store the 16-char hex string as 8 raw bytes (big-endian pairs)
    for (let i = 0; i < 8; i++) {
      buf[i + 1] = parseInt(connectionIdHex.slice(i * 2, i * 2 + 2), 16);
    }
    buf.write(payload, 9, "utf-8");
    this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer });
  }

  simulateError() {
    this.onerror?.({ type: "error" });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

class MockBidirectionalStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  writes: Uint8Array[] = [];
  private readController?: ReadableStreamDefaultController<Uint8Array>;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writes.push(chunk);
      },
    });
  }

  enqueue(data: Uint8Array) {
    this.readController?.enqueue(data);
  }

  close() {
    this.readController?.close();
  }
}

let mockWebTransportInstances: MockWebTransport[] = [];

class MockWebTransport {
  url: string;
  ready: Promise<void>;
  datagrams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  incomingBidirectionalStreams: ReadableStream<MockBidirectionalStream>;
  datagramWrites: Uint8Array[] = [];
  bidiStreams: MockBidirectionalStream[] = [];
  private datagramController?: ReadableStreamDefaultController<Uint8Array>;
  private incomingController?: ReadableStreamDefaultController<MockBidirectionalStream>;

  constructor(url: string) {
    this.url = url;
    this.ready = Promise.resolve();
    this.datagrams = {
      readable: new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.datagramController = controller;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.datagramWrites.push(chunk);
        },
      }),
    };
    this.incomingBidirectionalStreams = new ReadableStream<MockBidirectionalStream>({
      start: (controller) => {
        this.incomingController = controller;
      },
    });
  }

  createBidirectionalStream(): MockBidirectionalStream {
    const stream = new MockBidirectionalStream();
    this.bidiStreams.push(stream);
    return stream;
  }

  sendDatagram(data: Uint8Array) {
    this.datagramController?.enqueue(data);
  }

  enqueueIncoming(stream: MockBidirectionalStream) {
    this.incomingController?.enqueue(stream);
  }

  close() {
    this.datagramController?.close();
    this.incomingController?.close();
  }
}

describe("net-shim", () => {
  let OriginalWebSocket: typeof WebSocket | undefined;

  beforeEach(() => {
    mockInstances = [];
    OriginalWebSocket = globalThis.WebSocket as typeof WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    if (OriginalWebSocket) {
      globalThis.WebSocket = OriginalWebSocket;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).WebSocket;
    }
  });

  it("NoopTransport throws on connect", () => {
    const socket = new Socket();
    expect(() => socket.connect("localhost:5432")).toThrow(EXPECTED_CONNECT_ERROR);
  });

  it("createNetShim with no tcpRelay throws on connect", () => {
    const netShim = createNetShim(undefined);
    expect(() => netShim.connect({ port: 80 })).toThrow(EXPECTED_CONNECT_ERROR);
  });

  it("WebSocketTransport sends connect message and resolves on connected", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    // Wait for the connect message to be sent (async in onopen)
    await new Promise((resolve) => setTimeout(resolve, 0));
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("connect");
    expect(msg.host).toBe("localhost");
    expect(msg.port).toBe(5432);
    expect(msg.tls).toBeUndefined();
    expect(msg.connectionId).toHaveLength(16); // 8-byte hex
    // Echo the connectionId back as the relay does
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: msg.connectionId }));
    const { readable, writable } = await connectPromise;
    expect(readable).toBeDefined();
    expect(writable).toBeDefined();
  });

  it("WebSocketTransport sends data messages as binary frames", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    const { writable } = await connectPromise;
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode("hello"));
    // sent[0] = connect JSON, sentBinary[0] = data binary frame
    const frame = new Uint8Array(ws.sentBinary[0]);
    expect(frame[0]).toBe(0x03); // MSG_DATA
    expect(new TextDecoder().decode(frame.subarray(9))).toBe("hello");
  });

  it("WebSocketTransport receives data messages and exposes them on readable", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432 }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    const { readable } = await connectPromise;
    const reader = readable.getReader();
    // Simulate a binary data frame from the relay
    ws.simulateBinaryData(connectMsg.connectionId, "hello");
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("hello");
  });

  it("WebSocketTransport includes tls flag in connect message", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    transport.connect({ port: 443, host: "example.com", tls: true }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const msg = JSON.parse(ws.sent[0]);
    expect(msg.type).toBe("connect");
    expect(msg.host).toBe("example.com");
    expect(msg.port).toBe(443);
    expect(msg.tls).toBe(true);
    expect(msg.connectionId).toHaveLength(16);
  });

  it("Socket connects and emits connect event", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432, host: "localhost" });
    let connected = false;
    socket.on("connect", () => {
      connected = true;
    });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connected).toBe(true);
  });

  it("Socket writes and reads data through the transport", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    const chunks: Uint8Array[] = [];
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.write("hello");
    // sent[0] = connect JSON, sentBinary[0] = data binary frame
    const outFrame = new Uint8Array(ws.sentBinary[0]);
    expect(outFrame[0]).toBe(0x03);
    expect(new TextDecoder().decode(outFrame.subarray(9))).toBe("hello");

    ws.simulateBinaryData(connectMsg.connectionId, "world");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("world");
  });

  it("Socket end sends close message and destroy emits close", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.sent.some((s) => JSON.parse(s).type === "close")).toBe(true);

    socket.destroy();
    expect(closed).toBe(true);
  });

  it("createNetShim with tcpRelay creates a working Socket", async () => {
    const netShim = createNetShim(undefined, { tcpRelay: { url: "ws://localhost:9000" } });
    const socket = netShim.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectMsg = JSON.parse(ws.sent[0]);
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: connectMsg.connectionId }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket).toBeInstanceOf(netShim.Socket);
  });

  it("NoopTransport.listen throws", () => {
    const transport = new NoopTransport();
    expect(() =>
      transport.listen(
        0,
        "localhost",
        () => {},
        () => {},
      ),
    ).toThrow(
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage",
    );
  });

  it("Server with no transport throws on listen", async () => {
    const server = new Server();
    await expect(server.listen(0, "localhost")).rejects.toThrow(
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage",
    );
  });

  it("Server.listen emits listening and address returns relay-assigned port", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    let listening = false;
    server.on("listening", () => {
      listening = true;
    });
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "listen", port: 0, host: "localhost" });
    ws.simulateMessage(JSON.stringify({ type: "listening", port: 9001, host: "127.0.0.1" }));
    await listenPromise;
    expect(listening).toBe(true);
    expect(server.address()).toEqual({ port: 9001, host: "127.0.0.1", family: "IPv4" });
  });

  it("Server emits connection when relay sends connection", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    const sockets: Socket[] = [];
    server.on("connection", (socket: Socket) => sockets.push(socket));
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "listening", port: 9001, host: "127.0.0.1" }));
    await listenPromise;

    ws.simulateMessage(
      JSON.stringify({
        type: "connection",
        connectionId: "inbound-1",
        remoteAddress: "192.168.1.100",
        remotePort: 54321,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets.length).toBe(1);
    expect(sockets[0].remoteAddress).toBe("192.168.1.100");
    expect(sockets[0].remotePort).toBe(54321);
  });

  it("inbound Socket data round-trips through the relay", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    const sockets: Socket[] = [];
    server.on("connection", (socket: Socket) => sockets.push(socket));
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "listening", port: 9001, host: "127.0.0.1" }));
    await listenPromise;

    ws.simulateMessage(
      JSON.stringify({
        type: "connection",
        connectionId: "inbound00000001", // 16-char hex, relay-generated
        remoteAddress: "192.168.1.100",
        remotePort: 54321,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    const chunks: Uint8Array[] = [];
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));

    // Simulate binary data frame from relay
    ws.simulateBinaryData("inbound00000001", "hello from relay");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello from relay");

    socket.write("hello from socket");
    // Find the data binary frame (sentBinary, not sent)
    const outFrame = ws.sentBinary[0];
    expect(outFrame).toBeDefined();
    const frame = new Uint8Array(outFrame);
    expect(frame[0]).toBe(0x03);
    expect(new TextDecoder().decode(frame.subarray(9))).toBe("hello from socket");
  });

  it("Server.close sends unlisten and emits close when relay unlistened", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    let closed = false;
    server.on("close", () => {
      closed = true;
    });
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "listening", port: 9001, host: "127.0.0.1" }));
    await listenPromise;

    const closePromise = server.close();
    expect(ws.sent.some((s) => JSON.parse(s).type === "unlisten")).toBe(true);
    ws.simulateMessage(JSON.stringify({ type: "unlistened" }));
    await closePromise;
    expect(closed).toBe(true);
  });
});

describe("WebTransportTransport", () => {
  let OriginalWebTransport: unknown;

  beforeEach(() => {
    mockWebTransportInstances = [];
    OriginalWebTransport = (globalThis as unknown as { WebTransport?: unknown }).WebTransport;
    (globalThis as unknown as { WebTransport: typeof MockWebTransport }).WebTransport =
      class extends MockWebTransport {
        constructor(url: string) {
          super(url);
          mockWebTransportInstances.push(this);
        }
      };
  });

  afterEach(() => {
    if (OriginalWebTransport) {
      (globalThis as unknown as { WebTransport: unknown }).WebTransport = OriginalWebTransport;
    } else {
      delete (globalThis as unknown as { WebTransport?: unknown }).WebTransport;
    }
  });

  it("connect sends connect message and resolves on connected", async () => {
    const transport = new WebTransportTransport("https://localhost:9000/wt");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wt = mockWebTransportInstances[0];
    const stream = wt.bidiStreams[0];
    expect(stream).toBeDefined();
    const msg = JSON.parse(new TextDecoder().decode(stream.writes[0]));
    expect(msg).toEqual({ type: "connect", host: "localhost", port: 5432, tls: undefined });

    stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "connected" })));
    const { readable, writable } = await connectPromise;
    expect(readable).toBeDefined();
    expect(writable).toBeDefined();
  });

  it("listen sends listen datagram and resolves on listening", async () => {
    const transport = new WebTransportTransport("https://localhost:9000/wt");
    let connection: AcceptedConnection | undefined;
    const listenPromise = transport.listen(
      8080,
      "127.0.0.1",
      (conn) => {
        connection = conn;
      },
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wt = mockWebTransportInstances[0];
    const msg = JSON.parse(new TextDecoder().decode(wt.datagramWrites[0]));
    expect(msg).toEqual({ type: "listen", port: 8080, host: "127.0.0.1" });

    wt.sendDatagram(
      new TextEncoder().encode(
        JSON.stringify({ type: "listening", port: 8080, host: "127.0.0.1" }),
      ),
    );
    const handle = await listenPromise;
    expect(handle.port).toBe(8080);
    expect(handle.host).toBe("127.0.0.1");

    const inbound = new MockBidirectionalStream();
    inbound.enqueue(
      new TextEncoder().encode(JSON.stringify({ remoteAddress: "1.2.3.4", remotePort: 1234 })),
    );
    wt.enqueueIncoming(inbound);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection).toBeDefined();
    expect(connection!.remoteAddress).toBe("1.2.3.4");
    expect(connection!.remotePort).toBe(1234);
  });

  it("createNetShim uses WebTransportTransport when configured", async () => {
    const netShim = createNetShim(undefined, {
      tcpRelay: { url: "https://localhost:9000/wt", transport: "webtransport" },
    });
    const socket = netShim.connect({ port: 5432, host: "localhost" }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const wt = mockWebTransportInstances[0];
    const stream = wt.bidiStreams[0];
    stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "connected" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket).toBeInstanceOf(netShim.Socket);
  });
});
