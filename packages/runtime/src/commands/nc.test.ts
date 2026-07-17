import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nc } from "./nc.js";

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
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | Uint8Array | ArrayBuffer) {
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "c1" }));
    await new Promise((r) => setTimeout(r, 0));
    const bytes = btoa("hello");
    ws.simulateMessage(JSON.stringify({ type: "data", connectionId: "c1", bytes }));
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
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "c1" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    const dataMsg = JSON.parse(ws.sent[1]);
    expect(dataMsg.type).toBe("data");
    expect(atob(dataMsg.bytes)).toBe("a\nb");
    ws.simulateClose();
    await promise;
  });

  it("-z reports success and exits", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = nc(["-z", "example.com", "80"], output);
    const ws = instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "c1" }));
    await new Promise((r) => setTimeout(r, 0));
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith(
      "Connection to example.com 80 port [tcp/*] succeeded!\n",
    );
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
    ws.simulateMessage(JSON.stringify({ type: "listening", port: 8080, host: "127.0.0.1" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(output.stderr).toHaveBeenCalledWith("Listening on port 8080\n");

    ws.simulateMessage(
      JSON.stringify({
        type: "connection",
        connectionId: "inbound",
        remoteAddress: "1.2.3.4",
        remotePort: 1234,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const bytes = btoa("from client");
    ws.simulateMessage(JSON.stringify({ type: "data", connectionId: "inbound", bytes }));
    ws.simulateMessage(JSON.stringify({ type: "close", connectionId: "inbound" }));
    ws.simulateClose();
    const code = await promise;
    expect(code).toBe(0);
    expect(output.stdout).toHaveBeenCalledWith("from client");
  });
});
