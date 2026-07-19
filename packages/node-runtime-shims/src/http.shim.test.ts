import { describe, it, expect } from "vitest";
import type { SWSandbox } from "@bolojs/sw-sandbox";
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

  it("createNetShim with no tcpRelay throws on connect and Server.listen", async () => {
    const sandbox = makeMockSandbox();
    const netShim = createNetShim(sandbox as any);
    expect(() => netShim.connect({ port: 80 })).toThrow(
      "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage",
    );
    expect(() => new netShim.Socket().connect("localhost:80")).toThrow(
      "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage",
    );
    const server = netShim.createServer();
    await expect(server.listen(0)).rejects.toThrow(
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage",
    );
    expect(netShim.isIP("127.0.0.1")).toBe(4);
    expect(netShim.isIP("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(6);
    expect(netShim.isIP("not-an-ip")).toBe(0);
  });
});
