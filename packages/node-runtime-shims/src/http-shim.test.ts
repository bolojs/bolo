import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHttpShim } from "./http-shim";
import type { SWSandbox } from "@browser-containers/sw-sandbox";

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
        url: "http://localhost:3000",
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
        url: "http://localhost:3000",
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
        url: "http://localhost:3000",
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
