import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tcping } from "./tcping.js";

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

  constructor(url: string) {
    this.url = url;
  }

  send(_data: string | Uint8Array | ArrayBuffer) {
    // outbound control messages are ignored for tcping probes
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

  const connectInstance = () => {
    const ws = instances[instances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "connected", connectionId: "c" }));
    return ws;
  };

  it("prints open time on successful probe", async () => {
    const output = { stdout: vi.fn(), stderr: vi.fn() };
    const promise = tcping(["-c", "1", "example.com", "80"], output);
    connectInstance();
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
    connectInstance();
    await new Promise((r) => setTimeout(r, 1050));
    connectInstance();
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
