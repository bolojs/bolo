import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Socket,
  Server,
  WebSocketTransport,
  NoopTransport,
  createNetShim,
  createNetHandleTracker,
  isIP,
  isIPv4,
  isIPv6,
  type AcceptedConnection,
  type ByteTransport,
} from "./net-shim.js";
import { stream } from "@bolojs/node-web-shims";

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
  "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage";

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
    expect(() => new NoopTransport().connect({ port: 1 }, () => {})).toThrow(
      EXPECTED_CONNECT_ERROR,
    );
  });

  it("emits 'close' on the client socket when the peer ends, even unread", async () => {
    // Node's socket reads eagerly (lib/net.js calls `read(0)` right after
    // connect), so the FIN is observed and the socket destroys even when the
    // app never consumes the readable side. Without that the client socket
    // keeps its handle forever and 'close' never fires
    // (test-net-connect-buffer waits on it).
    const netShim = createNetShim(undefined);
    const server = netShim.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0 }, resolve));
    const port = (server.address() as { port: number }).port;

    const serverSocket = await new Promise<{ end: () => void }>((resolve) => {
      server.on("connection", (s) => resolve(s));
      const client = netShim.connect({ port });
      client.on("error", () => {});
      client.end();
    });

    const closed = new Promise<void>((resolve) => {
      const client = netShim.connect({ port });
      client.on("error", () => {});
      client.on("close", () => resolve());
      client.on("connect", () => client.end());
    });

    // The peer must close for the client's FIN to be observed.
    serverSocket.end();
    await expect(closed).resolves.toBeUndefined();
    server.close();
  });

  it("NoopTransport errors carry the ERR_BOL_UNSUPPORTED_NET_BACKEND seam code", () => {
    const connectErr = (() => {
      try {
        new NoopTransport().connect({ port: 1 }, () => {});
      } catch (e) {
        return e as Error & { code?: string };
      }
      throw new Error("expected connect to throw");
    })();
    expect(connectErr.code).toBe("ERR_BOL_UNSUPPORTED_NET_BACKEND");
    expect(String(connectErr)).toContain("[ERR_BOL_UNSUPPORTED_NET_BACKEND]");
  });

  it("createNetShim with no tcpRelay falls back to loopback (ECONNREFUSED on unbound ports)", async () => {
    const netShim = createNetShim(undefined);
    const socket = netShim.connect({ port: 1 });
    const err = await new Promise<Error & { code?: string }>((resolve) =>
      socket.on("error", resolve),
    );
    expect(err.code).toBe("ECONNREFUSED");
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
    // _write -> WritableStream writer.write -> sink write runs in microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage",
    );
  });

  it("Server with no explicit transport listens on the shared loopback", async () => {
    const server = new Server();
    await new Promise<void>((resolve) => server.listen({ port: 0 }, resolve));
    expect((server.address() as { port: number }).port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    expect(server.address()).toEqual({ port: 9001, address: "127.0.0.1", family: "IPv4" });
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

    const closeResult = server.close();
    expect(closeResult).toBe(server);
    const unlistenFrame = parseFrame(ws.sent[ws.sent.length - 1]);
    expect(unlistenFrame.type).toBe(FRAME_TYPE.UNLISTEN);
    expect(unlistenFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    ws.simulateMessage(buildFrame(FRAME_TYPE.UNLISTENED, LISTENER_CONNECTION_ID, EMPTY_PAYLOAD));
    await new Promise((resolve) => setTimeout(resolve, 0));
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

// ---------------------------------------------------------------------------
// Socket as stream.Duplex — fake ByteTransport (connect/write/close/events)
// ---------------------------------------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeTransport implements ByteTransport {
  connectCalls: Array<{ host?: string; port: number }> = [];
  connReadable!: ReadableStream<Uint8Array>;
  connWritable!: WritableStream<Uint8Array>;
  controller!: ReadableStreamDefaultController<Uint8Array>;
  written: Uint8Array[] = [];
  writerClosed = false;
  writerAborted = false;
  failConnectWith?: Error | string;
  delayConnect = false;
  private resolveConnect?: (v: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }) => void;
  listenCalls: Array<{ port: number; host: string }> = [];
  onConnection?: (conn: AcceptedConnection) => void;
  closeListener?: () => Promise<void>;
  listening = false;
  failListenWith?: Error;

  connect(options: { port: number; host?: string }) {
    this.connectCalls.push(options);
    this.connReadable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
    this.connWritable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.writerAborted) throw new Error("abort");
        this.written.push(chunk);
      },
      close: async () => {
        this.writerClosed = true;
      },
      abort: async () => {
        this.writerAborted = true;
      },
    });
    return new Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }>((resolve, reject) => {
      if (this.failConnectWith) {
        reject(
          typeof this.failConnectWith === "string"
            ? new Error(this.failConnectWith)
            : this.failConnectWith,
        );
        return;
      }
      if (this.delayConnect) {
        this.resolveConnect = resolve;
      } else {
        resolve({ readable: this.connReadable, writable: this.connWritable });
      }
    });
  }

  settleConnect() {
    this.resolveConnect?.({ readable: this.connReadable, writable: this.connWritable });
  }

  async feed(bytes: Uint8Array) {
    this.controller.enqueue(bytes);
    await tick();
  }

  async feedEnd() {
    this.controller.close();
    await tick();
  }

  listen(port: number, host: string, onConnection: (conn: AcceptedConnection) => void) {
    this.listenCalls.push({ port, host });
    this.onConnection = onConnection;
    return new Promise<{ port: number; host: string; close: () => Promise<void> }>(
      (resolve, reject) => {
        if (this.failListenWith) {
          reject(this.failListenWith);
          return;
        }
        this.listening = true;
        resolve({
          port: port === 0 ? 4321 : port,
          host,
          close: async () => {
            this.listening = false;
            this.closeListener?.();
          },
        });
      },
    );
  }

  accept(remoteAddress = "10.0.0.9", remotePort = 5150) {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
      },
    });
    const acceptedWrites: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        acceptedWrites.push(chunk);
      },
    });
    const conn: AcceptedConnection = {
      connectionId: "acc1",
      readable,
      writable,
      remoteAddress,
      remotePort,
      onError: undefined,
    };
    this.onConnection?.(conn);
    return { conn, controller: ctrl, acceptedWrites };
  }
}

describe("Socket as stream.Duplex", () => {
  it("is an instance of stream.Duplex / Readable / Writable", () => {
    const socket = new Socket(new FakeTransport(), { port: 1 });
    expect(socket).toBeInstanceOf(stream.Duplex);
    expect(socket).toBeInstanceOf(stream.Readable);
    // Node's Duplex copies Writable's methods onto its prototype rather than
    // chaining to Writable.prototype, so `instanceof stream.Writable` is false
    // (as in Node). Check the writable surface instead.
    expect(socket).toBeInstanceOf(stream.Stream);
    expect(typeof socket.write).toBe("function");
    expect(typeof socket.end).toBe("function");
    socket.destroy();
  });

  it("is callable without new", () => {
    const socket = (Socket as unknown as (t?: ByteTransport) => Socket)(new FakeTransport());
    expect(socket).toBeInstanceOf(Socket);
    socket.destroy();
  });

  it("connecting flag flips during connect; remoteAddress/remotePort are set", async () => {
    const t = new FakeTransport();
    t.delayConnect = true;
    const socket = new Socket(t);
    socket.connect(8080, "example.test");
    expect(socket.connecting).toBe(true);
    t.settleConnect();
    await tick();
    expect(socket.connecting).toBe(false);
    expect(socket.remoteAddress).toBe("example.test");
    expect(socket.remotePort).toBe(8080);
    expect(socket.remoteFamily).toBe("IPv4");
    socket.destroy();
  });

  it("connect(options, cb) emits connect via callback", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    const onConnect = vi.fn();
    socket.connect({ port: 1234, host: "h" }, onConnect);
    await tick();
    expect(onConnect).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it("write() queues while connecting and counts bytesWritten after flush", async () => {
    const t = new FakeTransport();
    t.delayConnect = true;
    const socket = new Socket(t, { port: 5 });
    socket.connect({ port: 5 });
    expect(socket.write("early")).toBe(true);
    expect(t.written.length).toBe(0);
    t.settleConnect();
    await tick();
    await tick();
    expect(t.written.length).toBe(1);
    expect(new TextDecoder().decode(t.written[0])).toBe("early");
    await tick();
    expect(socket.bytesWritten).toBe(5);
    socket.destroy();
  });

  it("incoming data flows to 'data' listeners and counts bytesRead", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    socket.connect({ port: 5, host: "h" });
    await tick();
    const received: Uint8Array[] = [];
    socket.on("data", (c: Uint8Array) => received.push(c));
    await t.feed(new TextEncoder().encode("abc"));
    expect(socket.bytesRead).toBe(3);
    expect(new TextDecoder().decode(received[0])).toBe("abc");
    socket.destroy();
  });

  it("pause() stops 'data', resume() re-arms the pump", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    socket.connect({ port: 5 });
    await tick();
    const received: Uint8Array[] = [];
    socket.on("data", (c: Uint8Array) => received.push(c));
    socket.pause();
    await t.feed(new TextEncoder().encode("x"));
    expect(received.length).toBe(0);
    socket.resume();
    await tick();
    expect(received.length).toBe(1);
    socket.destroy();
  });

  it("pipe() forwards chunks to a Writable", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    socket.connect({ port: 5 });
    await tick();
    const chunks: Uint8Array[] = [];
    const dest = new stream.Writable({
      write(chunk: unknown, _enc: string, cb: (e?: Error | null) => void) {
        chunks.push(chunk as Uint8Array);
        cb();
      },
    });
    socket.pipe(dest as never);
    await t.feed(new TextEncoder().encode("piped"));
    expect(new TextDecoder().decode(chunks[0])).toBe("piped");
    socket.destroy();
  });

  it("remote EOF emits 'end' then auto-end (allowHalfOpen=false)", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    const order: string[] = [];
    socket.on("end", () => order.push("end"));
    socket.on("close", () => order.push("close"));
    socket.connect({ port: 5 });
    await tick();
    // 'end' is only emitted once the readable side is consumed (flowing) —
    // faithful stream semantics: a paused stream buffers EOF indefinitely.
    socket.resume();
    await t.feedEnd();
    expect(order[0]).toBe("end");
    await tick();
    expect(socket.writableEnded).toBe(true);
    socket.destroy();
    await tick();
    expect(order).toContain("close");
  });

  it("end() emits finish and closes the transport writer (half-close)", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    socket.connect({ port: 5 });
    await tick();
    const finished = vi.fn();
    socket.on("finish", finished);
    socket.end();
    await tick();
    expect(finished).toHaveBeenCalledOnce();
    expect(t.writerClosed).toBe(true);
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it("destroy(err) emits error then close", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    const order: string[] = [];
    socket.on("error", () => order.push("error"));
    socket.on("close", () => order.push("close"));
    socket.connect({ port: 5 });
    await tick();
    socket.destroy(new Error("boom"));
    await tick();
    expect(order).toEqual(["error", "close"]);
    expect(socket.destroyed).toBe(true);
  });

  it("connect rejection maps to a coded ECONNREFUSED error event", async () => {
    const t = new FakeTransport();
    t.failConnectWith = "nope";
    const socket = new Socket(t);
    const errors: Array<Error & { code?: string; syscall?: string; port?: number }> = [];
    socket.on("error", (e: Error & { code?: string; syscall?: string; port?: number }) =>
      errors.push(e),
    );
    socket.connect(4444, "dead.host");
    await tick();
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("ECONNREFUSED");
    expect(errors[0].syscall).toBe("connect");
    expect(errors[0].message).toBe("connect ECONNREFUSED dead.host:4444");
    expect(socket.connecting).toBe(false);
  });

  it("transport-coded errors keep their code", async () => {
    const t = new FakeTransport();
    const coded = new Error("getaddrinfo ENOTFOUND nope") as Error & { code: string };
    coded.code = "ENOTFOUND";
    t.failConnectWith = coded;
    const socket = new Socket(t);
    const errors: Array<Error & { code?: string }> = [];
    socket.on("error", (e: Error & { code?: string }) => errors.push(e));
    socket.connect({ port: 1, host: "nope" });
    await tick();
    expect(errors[0].code).toBe("ENOTFOUND");
  });

  it("setTimeout emits 'timeout' after idle msec", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    const onTimeout = vi.fn();
    socket.connect({ port: 5 });
    await tick();
    socket.setTimeout(20, onTimeout);
    await new Promise((r) => setTimeout(r, 50));
    expect(onTimeout).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it("setNoDelay/setKeepAlive/ref/unref are chainable", async () => {
    const t = new FakeTransport();
    const socket = new Socket(t);
    socket.connect({ port: 5 });
    await tick();
    expect(socket.setNoDelay()).toBe(socket);
    expect(socket.setNoDelay(true)).toBe(socket);
    expect(socket.setKeepAlive(true, 1000)).toBe(socket);
    expect(socket.ref()).toBe(socket);
    expect(socket.unref()).toBe(socket);
    socket.destroy();
  });

  it("ref/unref toggle the tracked loop handle; released on destroy", async () => {
    const tracker = createNetHandleTracker();
    const t = new FakeTransport();
    const shim = createNetShim(undefined, { transport: t, handleTracker: tracker });
    const socket = shim.connect({ port: 5, host: "h" });
    await tick();
    expect(tracker.hasRefed()).toBe(true);
    socket.unref();
    expect(tracker.hasRefed()).toBe(false);
    socket.ref();
    expect(tracker.hasRefed()).toBe(true);
    socket.destroy();
    expect(tracker.hasRefed()).toBe(false);
  });
});

describe("Server shape", () => {
  it("is callable without new", () => {
    const s = (Server as unknown as (t?: ByteTransport) => Server)(new FakeTransport());
    expect(s).toBeInstanceOf(Server);
  });

  it("listen returns the server synchronously and sets listening", async () => {
    const t = new FakeTransport();
    const server = new Server(t);
    const ret = server.listen(0, "localhost");
    expect(ret).toBe(server);
    await tick();
    expect(server.listening).toBe(true);
    expect(t.listenCalls[0]).toEqual({ port: 0, host: "localhost" });
    expect(server.address()).toEqual({ port: 4321, address: "localhost", family: "IPv4" });
    server.close();
  });

  it("listen(options) honours backlog via maxConnections", async () => {
    const t = new FakeTransport();
    const server = new Server(t);
    server.listen({ port: 9000, host: "h", backlog: 64 });
    expect(server.maxConnections).toBe(64);
    await tick();
    expect(server.listening).toBe(true);
    server.close();
  });

  it("emits 'connection' with a real Duplex Socket; getConnections counts", async () => {
    const t = new FakeTransport();
    const server = new Server(t);
    const conns: Socket[] = [];
    server.on("connection", (s: Socket) => conns.push(s));
    server.listen(0);
    await tick();
    t.accept("1.2.3.4", 7777);
    expect(conns.length).toBe(1);
    expect(conns[0]).toBeInstanceOf(stream.Duplex);
    expect(conns[0].remoteAddress).toBe("1.2.3.4");
    expect(conns[0].remotePort).toBe(7777);
    const count = await new Promise<number>((resolve) =>
      server.getConnections((_e, n) => resolve(n)),
    );
    expect(count).toBe(1);
    conns[0].destroy();
    await tick();
    const count2 = await new Promise<number>((resolve) =>
      server.getConnections((_e, n) => resolve(n)),
    );
    expect(count2).toBe(0);
    server.close();
  });

  it("close on a non-listening server reports ERR_SERVER_NOT_RUNNING to the callback", async () => {
    const server = new Server(new FakeTransport());
    const err = await new Promise<Error | undefined>((resolve) => server.close((e) => resolve(e)));
    expect((err as Error & { code: string }).code).toBe("ERR_SERVER_NOT_RUNNING");
  });

  it("listen twice emits ERR_SERVER_ALREADY_LISTEN", async () => {
    const t = new FakeTransport();
    const server = new Server(t);
    const errors: Array<Error & { code?: string }> = [];
    server.on("error", (e: Error & { code?: string }) => errors.push(e));
    server.listen(0);
    await tick();
    server.listen(0);
    await tick();
    expect(errors[0]?.code).toBe("ERR_SERVER_ALREADY_LISTEN");
    server.close();
  });

  it("async listen failure maps to coded error event", async () => {
    const t = new FakeTransport();
    t.failListenWith = new Error("denied");
    const server = new Server(t);
    const errors: Array<Error & { code?: string; syscall?: string }> = [];
    server.on("error", (e: Error & { code?: string; syscall?: string }) => errors.push(e));
    server.listen(9999, "h");
    await tick();
    expect(errors[0].code).toBe("EADDRINUSE");
    expect(errors[0].syscall).toBe("listen");
    expect(server.listening).toBe(false);
  });

  it("listening server holds a ref'd handle until close", async () => {
    const tracker = createNetHandleTracker();
    const t = new FakeTransport();
    const shim = createNetShim(undefined, { transport: t, handleTracker: tracker });
    const server = shim.createServer();
    server.listen(0);
    await tick();
    expect(tracker.hasRefed()).toBe(true);
    server.unref();
    expect(tracker.hasRefed()).toBe(false);
    server.ref();
    expect(tracker.hasRefed()).toBe(true);
    server.close();
    await tick();
    expect(tracker.hasRefed()).toBe(false);
  });
});

describe("isIP", () => {
  it("classifies IPv4", () => {
    expect(isIP("127.0.0.1")).toBe(4);
    expect(isIPv4("255.255.255.255")).toBe(true);
    expect(isIPv4("256.1.1.1")).toBe(false);
    expect(isIP("1.2.3.4.5")).toBe(0);
  });

  it("classifies IPv6 incl. compressed and mapped forms", () => {
    expect(isIP("::1")).toBe(6);
    expect(isIP("fe80::1%eth0")).toBe(6);
    expect(isIP("2001:db8::ff00:42:8329")).toBe(6);
    expect(isIP("::ffff:127.0.0.1")).toBe(6);
    expect(isIPv6("::")).toBe(true);
    expect(isIP("not-an-ip")).toBe(0);
    expect(isIP("")).toBe(0);
  });
});
