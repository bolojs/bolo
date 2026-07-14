import { describe, it, expect } from "vitest";
import type { SWSandbox } from "@bolojs/sw-sandbox";
import { createHttpShim, createNetShim } from "./http-shim.js";
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

  it("createNetShim delegates to createHttpShim", () => {
    const sandbox = makeMockSandbox();
    const netShim = createNetShim(sandbox as any);
    netShim.createServer((_req, res) => res.end("net")).listen(0);
    expect(sandbox.handlers.length).toBe(1);
  });
});
