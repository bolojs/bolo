import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHttpShim, ServerImpl } from "./http-shim";
import type { SWSandbox } from "@bolojs/sandbox";

describe("http-shim - Port Discovery Events", () => {
  let mockSandbox: SWSandbox;
  const mockOnFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox = {
      onFetch: mockOnFetch,
      setPolicyRegistry: vi.fn(),
      handleInterceptedRequest: vi.fn(),
      origin: "http://localhost:3000",
      swPath: "/sw.js",
    } as unknown as SWSandbox;
  });

  describe("createHttpShim with onPortEvent callback", () => {
    it("should accept optional onPortEvent callback", () => {
      const onPortEvent = vi.fn();
      expect(() => createHttpShim(mockSandbox, { onPortEvent })).not.toThrow();
    });

    it("should work without onPortEvent callback", () => {
      expect(() => createHttpShim(mockSandbox)).not.toThrow();
    });
  });

  describe("server.listen() events", () => {
    it("should emit server-ready event with port and url when listen is called", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000);

      expect(onPortEvent).toHaveBeenCalledTimes(2);
      expect(onPortEvent).toHaveBeenCalledWith("server-ready", {
        port: 3000,
        url: "/__virtual__/3000",
      });
    });

    it("should emit port-open event when server starts listening", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000);

      expect(onPortEvent).toHaveBeenCalledWith("port-open", {
        port: 3000,
        url: "/__virtual__/3000",
      });
    });

    it("should use default port 3000 if not specified", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen();

      expect(onPortEvent).toHaveBeenCalledWith("server-ready", {
        port: 3000,
        url: "/__virtual__/3000",
      });
    });

    it("should call callback if provided", async () => {
      const callback = vi.fn();
      const { createServer } = createHttpShim(mockSandbox);

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000, "localhost", callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  describe("server.close() events", () => {
    it("should emit port-close event when close is called", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000);

      await server.close();

      expect(onPortEvent).toHaveBeenCalledWith("port-close", { port: 3000 });
    });

    it("should emit port-close with the port that was used", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(8080);

      await server.close();

      expect(onPortEvent).toHaveBeenCalledWith("port-close", { port: 8080 });
    });

    it("should handle close without prior listen gracefully", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);

      expect(async () => await server.close()).not.toThrow();
    });

    it("should disable fetch handler after close", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000);

      await server.close();

      const closeCalls = onPortEvent.mock.calls.filter((call) => call[0] === "port-close");
      expect(closeCalls.length).toBe(1);
    });
  });

  describe("Server chaining", () => {
    it("should support method chaining on listen", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);

      const result = await server.listen(3000);

      expect(result).toBe(server);
    });

    it("should support method chaining on close", async () => {
      const onPortEvent = vi.fn();
      const { createServer } = createHttpShim(mockSandbox, { onPortEvent });

      const handler = vi.fn();
      const server = createServer(handler);
      await server.listen(3000);

      const result = await server.close();

      expect(result).toBe(server);
    });
  });
});

describe("http-shim - Agent construction", () => {
  it("Agent is callable without new and instanceof-compatible both ways", () => {
    const shim = createHttpShim();
    const withoutNew = shim.Agent();
    expect(withoutNew instanceof shim.Agent).toBe(true);
    expect(new shim.Agent() instanceof shim.Agent).toBe(true);
    expect(withoutNew.maxSockets).toBe(Infinity);
    expect(withoutNew.maxFreeSockets).toBe(256);
    expect(withoutNew.keepAlive).toBe(false);
  });

  it("Agent honours options and pools connections", () => {
    const shim = createHttpShim();
    const agent = new shim.Agent({ maxSockets: 2, maxFreeSockets: 4, keepAlive: true });
    expect(agent.maxSockets).toBe(2);
    expect(agent.keepAlive).toBe(true);
    const a = agent.get("https://example.com");
    const b = agent.get("https://example.com");
    expect(b.controller).toBe(a.controller);
    b.detach();
    a.detach();
    expect(agent.get("https://example.com")).toBeDefined();
    agent.destroy();
  });
});

describe("http-shim - ServerResponse Node validation parity", () => {
  let mockSandbox: SWSandbox;
  const mockOnFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSandbox = {
      onFetch: mockOnFetch,
      setPolicyRegistry: vi.fn(),
      handleInterceptedRequest: vi.fn(),
      origin: "http://localhost:3000",
      swPath: "/sw.js",
    } as unknown as SWSandbox;
  });

  const listen = (server: ServerImpl) =>
    new Promise<void>((resolve) => {
      server.listen(0, function (this: unknown) {
        // Node invokes the listen callback with `this` bound to the server.
        expect(this).toBe(server);
        resolve();
      });
    });

  it("listen callback runs with this === server", async () => {
    const { createServer } = createHttpShim(mockSandbox);
    const server = createServer();
    await listen(server);
    await server.close();
  });

  it("setHeader/writeHead validate names and propagate status + raw headers", async () => {
    const { createServer } = createHttpShim(mockSandbox);
    const server = createServer((req, res) => {
      // Numeric names fail Node's type check even though "3840" is a valid
      // token — the raw value must reach validateHeaderName unstringified.
      expect(() => res.setHeader(3840 as never, "bar")).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_HTTP_TOKEN" }),
      );
      expect(() => res.setHeader("bad header", "x")).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_HTTP_TOKEN" }),
      );
      res.writeHead(418, ["X-Teapot", "yes", "X-Count", 42] as never);
      expect(res.statusCode).toBe(418);
      res.end("teapot");
    });
    await listen(server);
    const handler = mockOnFetch.mock.calls[0][0] as (req: Request) => Promise<Response>;
    const resp = await handler(new Request("http://localhost/__virtual__/1/"));
    expect(resp.status).toBe(418);
    expect(resp.headers.get("x-teapot")).toBe("yes");
    expect(resp.headers.get("x-count")).toBe("42");
    expect(await resp.text()).toBe("teapot");
    await server.close();
  });

  it("writeHead rejects a second call with ERR_HTTP_HEADERS_SENT", async () => {
    const { createServer } = createHttpShim(mockSandbox);
    const server = createServer((req, res) => {
      res.writeHead(200, { "x-a": "1" });
      expect(() => res.writeHead(200)).toThrowError(
        expect.objectContaining({ code: "ERR_HTTP_HEADERS_SENT" }),
      );
      res.end("ok");
    });
    await listen(server);
    const handler = mockOnFetch.mock.calls[0][0] as (req: Request) => Promise<Response>;
    const resp = await handler(new Request("http://localhost/__virtual__/1/"));
    expect(resp.status).toBe(200);
    await server.close();
  });
});
