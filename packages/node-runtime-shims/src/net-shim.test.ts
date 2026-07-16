import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Socket, Server, WebSocketTransport, NoopTransport, createNetShim } from "./net-shim.js";

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
  onmessage?: (event: { data: string }) => void;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    mockInstances.push(this);
  }

  send(data: string | Uint8Array) {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.sent.push(text);
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
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "connect",
      host: "localhost",
      port: 5432,
      tls: undefined,
    });
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
    const { readable, writable } = await connectPromise;
    expect(readable).toBeDefined();
    expect(writable).toBeDefined();
  });

  it("WebSocketTransport sends data messages as base64 JSON", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432, host: "localhost" }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
    const { writable } = await connectPromise;
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode("hello"));
    const msg = JSON.parse(ws.sent[1]);
    expect(msg.type).toBe("data");
    expect(msg.connectionId).toBe("abc");
    expect(atob(msg.bytes)).toBe("hello");
  });

  it("WebSocketTransport receives data messages and exposes them on readable", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    const connectPromise = transport.connect({ port: 5432 }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
    const { readable } = await connectPromise;
    const reader = readable.getReader();
    const bytes = btoa("hello");
    ws.simulateMessage(JSON.stringify({ type: "data", connectionId: "abc", bytes }));
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("hello");
  });

  it("WebSocketTransport includes tls flag in connect message", async () => {
    const transport = new WebSocketTransport("ws://localhost:9000");
    transport.connect({ port: 443, host: "example.com", tls: true }, () => {});
    const ws = mockInstances[mockInstances.length - 1];
    ws.simulateOpen();
    const msg = JSON.parse(ws.sent[0]);
    expect(msg).toEqual({ type: "connect", host: "example.com", port: 443, tls: true });
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    socket.write("hello");
    const sent = JSON.parse(ws.sent[1]);
    expect(sent.type).toBe("data");
    expect(sent.connectionId).toBe("abc");
    expect(atob(sent.bytes)).toBe("hello");

    const bytes = btoa("world");
    ws.simulateMessage(JSON.stringify({ type: "data", connectionId: "abc", bytes }));
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "abc" }));
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
        connectionId: "inbound-1",
        remoteAddress: "192.168.1.100",
        remotePort: 54321,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    const chunks: Uint8Array[] = [];
    socket.on("data", (chunk: Uint8Array) => chunks.push(chunk));

    const bytes = btoa("hello from relay");
    ws.simulateMessage(JSON.stringify({ type: "data", connectionId: "inbound-1", bytes }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello from relay");

    socket.write("hello from socket");
    const sent = ws.sent.find((s) => {
      try {
        return JSON.parse(s).type === "data" && JSON.parse(s).connectionId === "inbound-1";
      } catch {
        return false;
      }
    });
    expect(sent).toBeDefined();
    const msg = JSON.parse(sent!);
    expect(atob(msg.bytes)).toBe("hello from socket");
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
