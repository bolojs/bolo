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
  sent: Uint8Array[] = [];

  constructor(url: string) {
    this.url = url;
    mockInstances.push(this);
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.sent.push(bytes);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: string | Uint8Array | ArrayBuffer) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.onmessage?.({ data: bytes.buffer });
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

  it("WebSocketTransport sends connect frame and resolves on connected", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    const sent = parseFrame(ws.sent[0]);
    expect(sent.type).toBe(FRAME_TYPE.CONNECT);
    expect(sent.connectionId).toBe(LISTENER_CONNECTION_ID);
    expect(JSON.parse(new TextDecoder().decode(sent.payload))).toEqual({
      host: "localhost",
      port: 5432,
      tls: undefined,
    });
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    const { readable, writable } = await connectPromise;
    expect(readable).toBeDefined();
    expect(writable).toBeDefined();
  });

  it("WebSocketTransport sends data frames as raw bytes", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    const { writable } = await connectPromise;
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode("hello"));
    const sent = parseFrame(ws.sent[1]);
    expect(sent.type).toBe(FRAME_TYPE.DATA);
    expect(sent.connectionId).toBe("abc00000");
    expect(new TextDecoder().decode(sent.payload)).toBe("hello");
  });

  it("WebSocketTransport receives data frames and exposes them on readable", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432 }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    const { readable } = await connectPromise;
    const reader = readable.getReader();
    ws.simulateMessage(buildFrame(FRAME_TYPE.DATA, "abc00000", new TextEncoder().encode("hello")));
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("hello");
  });

  it("WebSocketTransport includes tls flag in connect frame", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    transport.connect({ port: 443, host: "example.com", tls: true }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    const sent = parseFrame(ws.sent[0]);
    const msg = JSON.parse(new TextDecoder().decode(sent.payload));
    expect(msg).toEqual({ host: "example.com", port: 443, tls: true });
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
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
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
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.write("hello");
    const sent = parseFrame(ws.sent[1]);
    expect(sent.type).toBe(FRAME_TYPE.DATA);
    expect(sent.connectionId).toBe("abc00000");
    expect(new TextDecoder().decode(sent.payload)).toBe("hello");

    ws.simulateMessage(buildFrame(FRAME_TYPE.DATA, "abc00000", new TextEncoder().encode("world")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("world");
  });

  it("Socket end sends close frame and destroy emits close", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const endFrame = parseFrame(ws.sent[ws.sent.length - 1]);
    expect(endFrame.type).toBe(FRAME_TYPE.CLOSE);
    expect(endFrame.connectionId).toBe("abc00000");

    socket.destroy();
    expect(closed).toBe(true);
  });

  it("createNetShim with tcpRelay creates a working Socket", async () => {
    const netShim = createNetShim(undefined, { tcpRelay: { url: "ws://localhost:9000" } });
    const socket = netShim.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
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
    const listenFrame = parseFrame(ws.sent[0]);
    expect(listenFrame.type).toBe(FRAME_TYPE.LISTEN);
    expect(listenFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    expect(JSON.parse(new TextDecoder().decode(listenFrame.payload))).toEqual({
      port: 0,
      host: "localhost",
    });
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.LISTENING,
        LISTENER_CONNECTION_ID,
        jsonPayload({ port: 9001, host: "127.0.0.1" }),
      ),
    );
    await listenPromise;
    expect(listening).toBe(true);
    expect(server.address()).toEqual({ port: 9001, host: "127.0.0.1", family: "IPv4" });
  });

  it("Server emits connection when relay sends accept", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    const sockets: Socket[] = [];
    server.on("connection", (socket: Socket) => sockets.push(socket));
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.LISTENING,
        LISTENER_CONNECTION_ID,
        jsonPayload({ port: 9001, host: "127.0.0.1" }),
      ),
    );
    await listenPromise;

    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ACCEPT,
        "inbound1",
        jsonPayload({ remoteAddress: "192.168.1.100", remotePort: 54321 }),
      ),
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
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.LISTENING,
        LISTENER_CONNECTION_ID,
        jsonPayload({ port: 9001, host: "127.0.0.1" }),
      ),
    );
    await listenPromise;

    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ACCEPT,
        "inbound1",
        jsonPayload({ remoteAddress: "192.168.1.100", remotePort: 54321 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    const chunks: Uint8Array[] = [];
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));

    ws.simulateMessage(
      buildFrame(FRAME_TYPE.DATA, "inbound1", new TextEncoder().encode("hello from relay")),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello from relay");

    socket.write("hello from socket");
    const dataFrame = ws.sent
      .map((bytes) => parseFrame(bytes))
      .find((frame) => frame.type === FRAME_TYPE.DATA && frame.connectionId === "inbound1");
    expect(dataFrame).toBeDefined();
    expect(new TextDecoder().decode(dataFrame!.payload)).toBe("hello from socket");
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
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.LISTENING,
        LISTENER_CONNECTION_ID,
        jsonPayload({ port: 9001, host: "127.0.0.1" }),
      ),
    );
    await listenPromise;

    const closePromise = server.close();
    const unlistenFrame = parseFrame(ws.sent[ws.sent.length - 1]);
    expect(unlistenFrame.type).toBe(FRAME_TYPE.UNLISTEN);
    expect(unlistenFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    ws.simulateMessage(buildFrame(FRAME_TYPE.UNLISTENED, LISTENER_CONNECTION_ID, EMPTY_PAYLOAD));
    await closePromise;
    expect(closed).toBe(true);
  });

  it("Socket.end half-close keeps WS open until relay sends close", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    ws.simulateMessage(buildFrame(FRAME_TYPE.CLOSE, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("Socket.destroy closes WS immediately", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("three concurrent connections each close their own WS when destroyed", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const sockets: Socket[] = [];
    for (let i = 0; i < 3; i++) {
      sockets.push(new Socket(transport, { port: 8000 + i }));
      sockets[i].connect(`localhost:${8000 + i}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      mockInstances[i].simulateOpen();
      mockInstances[i].simulateMessage(
        buildFrame(FRAME_TYPE.CONNECTED, `conn000${i + 1}`, EMPTY_PAYLOAD),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    sockets[0].destroy();
    sockets[1].destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances[0].readyState).toBe(MockWebSocket.CLOSED);
    expect(mockInstances[1].readyState).toBe(MockWebSocket.CLOSED);
    expect(mockInstances[2].readyState).toBe(MockWebSocket.OPEN);

    sockets[2].destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInstances[2].readyState).toBe(MockWebSocket.CLOSED);
  });

  it("relay error frame before connected rejects with ECONNREFUSED", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 1, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ERROR,
        LISTENER_CONNECTION_ID,
        jsonPayload({
          code: "ECONNREFUSED",
          syscall: "connect",
          message: "Connection refused",
        }),
      ),
    );
    let caught: (Error & { code?: string }) | undefined;
    try {
      await connectPromise;
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe("Connection refused");
    expect(caught!.code).toBe("ECONNREFUSED");
  });

  it("emits error on Socket when WS errors post-connect", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    const errors: Error[] = [];
    socket.on("error", (err: Error) => errors.push(err));
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    ws.simulateError();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("WebSocket error");
  });

  it("sends large data frames without base64 crash", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    const { writable } = await connectPromise;
    const writer = writable.getWriter();
    const large = new Uint8Array(256 * 1024);
    large.fill(0xab);
    await writer.write(large);
    const dataFrame = parseFrame(ws.sent[1]);
    expect(dataFrame.type).toBe(FRAME_TYPE.DATA);
    expect(dataFrame.connectionId).toBe("abc00000");
    expect(dataFrame.payload.length).toBe(256 * 1024);
    expect(dataFrame.payload.every((byte) => byte === 0xab)).toBe(true);
  });

  it("parses binary frames for various types", () => {
    const connectFrame = buildFrame(
      FRAME_TYPE.CONNECT,
      LISTENER_CONNECTION_ID,
      jsonPayload({ host: "example.com", port: 443 }),
    );
    const parsed = parseFrame(connectFrame);
    expect(parsed.type).toBe(FRAME_TYPE.CONNECT);
    expect(parsed.connectionId).toBe(LISTENER_CONNECTION_ID);
    expect(JSON.parse(new TextDecoder().decode(parsed.payload))).toEqual({
      host: "example.com",
      port: 443,
    });

    const dataFrame = buildFrame(FRAME_TYPE.DATA, "abc12300", new TextEncoder().encode("hello"));
    const parsedData = parseFrame(dataFrame);
    expect(parsedData.type).toBe(FRAME_TYPE.DATA);
    expect(parsedData.connectionId).toBe("abc12300");
    expect(new TextDecoder().decode(parsedData.payload)).toBe("hello");
  });

  it("Socket queues data until data listener is attached", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const socket = new Socket(transport, { port: 5432 });
    socket.connect("localhost:5432");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "abc00000", EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));

    ws.simulateMessage(buildFrame(FRAME_TYPE.DATA, "abc00000", new TextEncoder().encode("queued")));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const chunks: Uint8Array[] = [];
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("queued");
  });

  it("inbound Socket.destroy sends destroy frame without closing listener WS", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    const sockets: Socket[] = [];
    server.on("connection", (socket: Socket) => sockets.push(socket));
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(
      buildFrame(FRAME_TYPE.LISTENING, LISTENER_CONNECTION_ID, jsonPayload({ port: 9001, host: "127.0.0.1" })),
    );
    await listenPromise;

    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ACCEPT,
        "inbound1",
        jsonPayload({ remoteAddress: "192.168.1.100", remotePort: 54321 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const destroyFrame = ws.sent
      .map((bytes) => parseFrame(bytes))
      .find((frame) => frame.type === FRAME_TYPE.DESTROY && frame.connectionId === "inbound1");
    expect(destroyFrame).toBeDefined();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  it("inbound Socket emits error when relay sends error frame", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const server = new Server(transport);
    const sockets: Socket[] = [];
    server.on("connection", (socket: Socket) => sockets.push(socket));
    const listenPromise = server.listen(0, "localhost");
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(
      buildFrame(FRAME_TYPE.LISTENING, LISTENER_CONNECTION_ID, jsonPayload({ port: 9001, host: "127.0.0.1" })),
    );
    await listenPromise;

    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ACCEPT,
        "inbound1",
        jsonPayload({ remoteAddress: "192.168.1.100", remotePort: 54321 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    const errors: (Error & { code?: string })[] = [];
    socket.on("error", (err: Error & { code?: string }) => errors.push(err));
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ERROR,
        "inbound1",
        jsonPayload({ code: "ECONNRESET", message: "Connection reset" }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("Connection reset");
    expect(errors[0].code).toBe("ECONNRESET");
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
