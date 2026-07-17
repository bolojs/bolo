import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tcping } from "./tcping.js";

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

describe("tcping", () => {
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

  const connectInstance = (id: string) => {
    const ws = instances[instances.length - 1];
    ws.simulateOpen();
    const connectFrame = parseFrame(ws.sent[0]);
    expect(connectFrame.type).toBe(FRAME_TYPE.CONNECT);
    expect(connectFrame.connectionId).toBe(LISTENER_CONNECTION_ID);
    ws.simulateMessage(buildFrame(FRAME_TYPE.CONNECTED, id, EMPTY_PAYLOAD));
    return ws;
  };

  it("prints open time on successful probe", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = tcping(["-c", "1", "example.com", "80"], output);
    connectInstance("c0000000");
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith(expect.stringMatching(/example.com 80 open time=/));
  });

  it("prints closed on timeout", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await tcping(["-c", "1", "-t", "0.05", "example.com", "80"], output);
    expect(code).toBe(1);
    expect(output.stdout).toHaveBeenCalledWith("example.com 80 closed/no response\n");
  });

  it("summary counts open and closed", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = tcping(["-c", "2", "example.com", "80"], output);
    connectInstance("c0000000");
    await new Promise((r) => setTimeout(r, 1050));
    connectInstance("c0000001");
    const code = await promise;
    const all = output.stdout.mock.calls.map((c) => c[0]).join("");
    expect(code).toBe(0);
    expect(all).toContain("2 probes sent, 2 open, 0 closed, 0% loss");
    expect(all).toContain("rtt min/avg/max");
  });

  it("errors without __tcpRelay", async () => {
    (globalThis as unknown as { __tcpRelay?: unknown }).__tcpRelay = undefined;
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const code = await tcping(["example.com", "80"], output);
    expect(code).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining("__tcpRelay"));
  });
});
