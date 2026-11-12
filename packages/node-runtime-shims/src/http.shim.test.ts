import { describe, it, expect } from "vitest";
import type { SWSandbox } from "@bolojs/sandbox";
import { createHttpShim } from "./http-shim.js";
import { createNetShim } from "./net-shim.js";
import type http from "node:http";

describe("http shim", () => {
  const makeMockSandbox = () => {
    type FetchHandler = Parameters<SWSandbox["onFetch"]>[0];
    const handlers: FetchHandler[] = [];
    return {
      onFetch: (h: FetchHandler) => handlers.push(h),
      handlers,
    };
  };

  it("createServer registers fetch handler on sandbox", () => {
    const sandbox = makeMockSandbox();
    const shim = createHttpShim(sandbox as any); // as any: minimal mock shape
    const _typeCheck: typeof http = shim as unknown as typeof http;
    void _typeCheck;

    const server = shim.createServer((_req, res) => {
      res.writeHead(200, { "X-Test": "ok" });
      res.end("hello");
    });
    server.listen(8080);
    expect(sandbox.handlers.length).toBeGreaterThan(0);
  });

  it("createServer returns a request-response cycle", async () => {
    const sandbox = makeMockSandbox();
    const shim = createHttpShim(sandbox as any);

    const server = shim.createServer((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    server.listen(3000);

    const req = new Request("http://localhost:3000/api/test", { method: "POST" });
    const resp = await sandbox.handlers[0](req);
    expect(resp.status).toBe(201);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    expect(await resp.text()).toBe('{"ok":true}');
  });

  it("exports METHODS, STATUS_CODES, Server, and header helpers", () => {
    const shim = createHttpShim();
    expect(Array.isArray(shim.METHODS)).toBe(true);
    expect(shim.METHODS).toContain("GET");
    expect(shim.METHODS).toContain("POST");
    expect(shim.STATUS_CODES[200]).toBe("OK");
    expect(shim.STATUS_CODES[404]).toBe("Not Found");
    expect(shim.maxHeaderSize).toBe(16384);

    expect(() => shim.validateHeaderName("content-type")).not.toThrow();
    expect(() => shim.validateHeaderName("invalid header")).toThrow();

    expect(() => shim.validateHeaderValue("content-type", "text/plain")).not.toThrow();
    expect(() => shim.validateHeaderValue("content-type", undefined)).toThrow();

    // Server constructor & callable shape
    const s1 = new shim.Server();
    expect(s1).toBeInstanceOf(shim.Server);
    const s2 = shim.Server();
    expect(s2).toBeInstanceOf(shim.Server);
    expect(typeof s1.listen).toBe("function");
    expect(typeof s1.close).toBe("function");
    expect(s1.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port: 0 });

    // OutgoingMessage / ServerResponse methods
    const res = new shim.ServerResponse();
    res.setHeader("X-Foo", "bar");
    expect(res.getHeader("x-foo")).toBe("bar");
    expect(res.hasHeader("x-foo")).toBe(true);
    expect(res.getHeaderNames()).toContain("x-foo");
    expect(res.getHeaders()["x-foo"]).toBe("bar");
    res.appendHeader("X-Foo", "baz");
    expect(res.getHeader("x-foo")).toBe("bar, baz");
    res.removeHeader("X-Foo");
    expect(res.hasHeader("x-foo")).toBe(false);
  });

  it("createNetShim without a relay falls back to loopback transports", async () => {
    const sandbox = makeMockSandbox();
    const netShim = createNetShim(sandbox as any);
    const socket = netShim.connect({ port: 1 });
    const err = await new Promise<Error & { code?: string }>((resolve) =>
      socket.on("error", resolve),
    );
    expect(err.code).toBe("ECONNREFUSED");
    const sockErr = await new Promise<Error & { code?: string }>((resolve) => {
      const s = new netShim.Socket();
      s.on("error", resolve);
      s.connect("localhost:1");
    });
    expect(sockErr.code).toBe("ECONNREFUSED");
    const server = netShim.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0 }, resolve));
    expect((server.address() as { port: number }).port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(netShim.isIP("127.0.0.1")).toBe(4);
    expect(netShim.isIP("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(6);
    expect(netShim.isIP("not-an-ip")).toBe(0);
  });
});
