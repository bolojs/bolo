import { describe, it, expect, vi, beforeEach } from "vitest";
import { SWSandbox } from "./sw-sandbox.js";

const mockSw = {
  postMessage: vi.fn(),
};
const mockRegistration = {
  active: mockSw,
  installing: null,
  waiting: null,
};
let port1MessageHandlers: Array<(event: MessageEvent) => void> = [];
let portReadyTrigger: (() => void) | null = null;

class MockMessageChannel {
  port1 = {
    addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
      if (type === "message") {
        port1MessageHandlers.push(handler);
        if (portReadyTrigger) {
          portReadyTrigger();
        }
      }
    }),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
  } as unknown as MessagePort;
  port2 = {} as MessagePort;
}

function setupMockNavigator() {
  port1MessageHandlers = [];
  portReadyTrigger = null;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        register: vi.fn().mockResolvedValue(mockRegistration),
        ready: Promise.resolve(mockRegistration),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  });
  globalThis.MessageChannel = MockMessageChannel as unknown as typeof MessageChannel;
}

function simulatePortReady() {
  for (const handler of port1MessageHandlers) {
    handler({ data: { type: "PORT_READY" } } as MessageEvent);
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockSw.postMessage.mockClear();
  setupMockNavigator();
});

describe("SWSandbox", () => {
  it("creates instance via SWSandbox.create()", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    expect(sandbox).toBeInstanceOf(SWSandbox);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js");
    expect(mockSw.postMessage).toHaveBeenCalledWith(
      { type: "INIT_PORT" },
      expect.arrayContaining([expect.anything()]),
    );
  });

  it("stores fetch handlers via onFetch()", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const handler = vi.fn().mockResolvedValue(new Response("handled"));
    sandbox.onFetch(handler);

    const req = new Request("http://localhost:3000/api/test");
    const result = await sandbox.handleInterceptedRequest(1, req);

    expect(handler).toHaveBeenCalledWith(req);
    expect(result.status).toBe(200);
  });

  it("returns 404 when no handler matches", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const req = new Request("http://localhost:3000/api/missing");
    const result = await sandbox.handleInterceptedRequest(2, req);

    expect(result.status).toBe(404);
  });

  it("skips handlers that throw and tries next", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const failingHandler = vi.fn().mockRejectedValue(new Error("fail"));
    const successHandler = vi.fn().mockResolvedValue(new Response("ok"));
    sandbox.onFetch(failingHandler);
    sandbox.onFetch(successHandler);

    const req = new Request("http://localhost:3000/api/test");
    const result = await sandbox.handleInterceptedRequest(3, req);

    expect(failingHandler).toHaveBeenCalledWith(req);
    expect(successHandler).toHaveBeenCalledWith(req);
    expect(result.status).toBe(200);
  });

  it("stores policy registry via setPolicyRegistry()", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const registry = new Map<string, unknown>([["network", true]]);
    sandbox.setPolicyRegistry(registry);

    const req = new Request("http://localhost:3000/api/test");
    const result = await sandbox.handleInterceptedRequest(4, req);
    expect(result.status).toBe(404);
  });

  it("throws when navigator.serviceWorker is not available", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      writable: true,
      configurable: true,
    });

    await expect(
      SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" }),
    ).rejects.toThrow("ServiceWorker not supported");
  });

  it("handleFetchRequest reconstructs Request, handles it, and posts FETCH_RESPONSE", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const handler = vi.fn().mockResolvedValue(new Response("hello from handler", { status: 200 }));
    sandbox.onFetch(handler);

    const postMessageSpy = vi.fn();
    (
      sandbox as unknown as { messagePort: { postMessage: typeof postMessageSpy } }
    ).messagePort.postMessage = postMessageSpy;

    const requestBody = new TextEncoder().encode('{"key":"value"}').buffer;
    await (
      sandbox as unknown as {
        handleFetchRequest: (
          id: number,
          req: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer },
        ) => Promise<void>;
      }
    ).handleFetchRequest(42, {
      url: "http://localhost:3000/api/test",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    expect(handler).toHaveBeenCalled();
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const [message, transfer] = postMessageSpy.mock.calls[0];
    expect(message).toEqual(
      expect.objectContaining({
        type: "FETCH_RESPONSE",
        requestId: 42,
      }),
    );
    expect(message.response.status).toBe(200);
    expect(new TextDecoder().decode(message.response.body)).toBe("hello from handler");
    expect(transfer).toEqual([message.response.body]);
  });

  it("round-trips a binary body byte-for-byte through handleFetchRequest", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128]);
    sandbox.onFetch(async (req) => new Response(await req.arrayBuffer(), { status: 200 }));

    const postMessageSpy = vi.fn();
    (
      sandbox as unknown as { messagePort: { postMessage: typeof postMessageSpy } }
    ).messagePort.postMessage = postMessageSpy;

    await (
      sandbox as unknown as {
        handleFetchRequest: (
          id: number,
          req: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer },
        ) => Promise<void>;
      }
    ).handleFetchRequest(7, {
      url: "http://localhost:3000/api/binary",
      method: "POST",
      headers: {},
      body: bytes.buffer,
    });

    const [message] = postMessageSpy.mock.calls[0];
    expect(new Uint8Array(message.response.body)).toEqual(bytes);
  });

  it("handleFetchRequest returns 404 when no handler matches", async () => {
    const createPromise = SWSandbox.create({ origin: "http://localhost:3000", swPath: "/sw.js" });
    portReadyTrigger = simulatePortReady;
    const sandbox = await createPromise;

    const postMessageSpy = vi.fn();
    (
      sandbox as unknown as { messagePort: { postMessage: typeof postMessageSpy } }
    ).messagePort.postMessage = postMessageSpy;

    await (
      sandbox as unknown as {
        handleFetchRequest: (
          id: number,
          req: { url: string; method: string; headers: Record<string, string>; body?: string },
        ) => Promise<void>;
      }
    ).handleFetchRequest(99, {
      url: "http://localhost:3000/api/missing",
      method: "GET",
      headers: {},
    });

    // ponytail: response body is now an ArrayBuffer + transfer list, mirror the binary round-trip test.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const [message, transfer] = postMessageSpy.mock.calls[0];
    expect(message).toEqual(expect.objectContaining({ type: "FETCH_RESPONSE", requestId: 99 }));
    expect(message.response.status).toBe(404);
    expect(new TextDecoder().decode(message.response.body)).toBe("Not found");
    expect(transfer).toEqual([message.response.body]);
  });
});
