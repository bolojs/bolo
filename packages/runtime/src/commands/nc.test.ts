import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nc } from "./nc.js";

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

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  binaryType = "arraybuffer";
  onopen?: () => void;
  onerror?: (event: { type: string }) => void;
  onclose?: () => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  readyState = MockWebSocket.CONNECTING;
  sent: Uint8Array[] = [];

  constructor(url: string) {
    this.url = url;
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

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("nc", () => {
  let originalWebSocket: typeof WebSocket;
  let instances: MockWebSocket[] = [];
  let originalRelay: unknown;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    instances = [];
    globalThis.WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    } as unknown as typeof WebSocket;
    originalRelay = (globalThis as unknown as { __tcpRelay?: unknown }).__tcpRelay;
    (globalThis as unknown as { __tcpRelay?: { url: string } }).__tcpRelay = {
      url: "ws://localhost:9000",
    };
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    (globalThis as unknown as { __tcpRelay?: unknown }).__tcpRelay = originalRelay;
  });

  it("connects and prints received data", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = nc(["example.com", "80"], output);
    const ws = instances[0];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "c1000000", EMPTY_PAYLOAD));
    await new Promise((r) => setTimeout(r, 0));
    ws.simulateMessage(buildFrame(FRAME_TYPE.DATA, "c1000000", new TextEncoder().encode("hello")));
    ws.simulateClose();
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith("hello");
  });

  it("sends -d data and escapes \\n", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = nc(["-d", "a\\nb", "example.com", "80"], output);
    const ws = instances[0];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "c1000000", EMPTY_PAYLOAD));
    await new Promise((r) => setTimeout(r, 0));
    const frames = ws.sent.map((bytes) => parseFrame(bytes));
    const connectFrame = frames[0];
    expect(connectFrame.type).toBe(FRAME_TYPE.CONNECT);
    expect(connectFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    expect(JSON.parse(new TextDecoder().decode(connectFrame.payload))).toEqual({
      host: "example.com",
      port: 80,
    });
    const dataFrame = frames[1];
    expect(dataFrame.type).toBe(FRAME_TYPE.DATA);
    expect(dataFrame.connectionId).toBe("c1000000");
    expect(new TextDecoder().decode(dataFrame.payload)).toBe("a\nb");
    const closeFrame = frames[frames.length - 1];
    expect(closeFrame.type).toBe(FRAME_TYPE.CLOSE);
    expect(closeFrame.connectionId).toBe("c1000000");
    ws.simulateClose();
    await promise;
  });

  it("-z reports success and exits", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = nc(["-z", "example.com", "80"], output);
    const ws = instances[0];
    ws.simulateOpen();
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, "c1000000", EMPTY_PAYLOAD));
    await new Promise((r) => setTimeout(r, 0));
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith(
      "Connection to example.com 80 port [tcp/*] succeeded!\n",
    );
    const destroyFrame = parseFrame(ws.sent[ws.sent.length - 1]);
    expect(destroyFrame.type).toBe(FRAME_TYPE.DESTROY);
    expect(destroyFrame.connectionId).toBe("c1000000");
  });

  it("errors without __tcpRelay", async () => {
    (globalThis as unknown as { __tcpRelay?: unknown }).__tcpRelay = undefined;
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await nc(["example.com", "80"], output);
    expect(code).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining("__tcpRelay"));
  });

  it("listen mode accepts one inbound connection", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = nc(["-l", "8080"], output);
    const ws = instances[0];
    ws.simulateOpen();
    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.LISTENING,
        LISTENER_CONNECTION_ID,
        jsonPayload({ port: 8080, host: "127.0.0.1" }),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(output.stderr).toHaveBeenCalledWith("Listening on port 8080\n");

    const listenFrame = parseFrame(ws.sent[0]);
    expect(listenFrame.type).toBe(FRAME_TYPE.LISTEN);
    expect(listenFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    expect(JSON.parse(new TextDecoder().decode(listenFrame.payload))).toEqual({
      port: 8080,
      host: "0.0.0.0",
    });

    ws.simulateMessage(
      buildFrame(
        FRAME_TYPE.ACCEPT,
        "inbound1",
        jsonPayload({ remoteAddress: "1.2.3.4", remotePort: 1234 }),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    ws.simulateMessage(
      buildFrame(FRAME_TYPE.DATA, "inbound1", new TextEncoder().encode("from client")),
    );
    ws.simulateMessage(buildFrame(FRAME_TYPE.CLOSE, "inbound1", EMPTY_PAYLOAD));
    ws.simulateClose();
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith("from client");
  });
});
