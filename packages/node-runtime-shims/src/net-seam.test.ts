import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createLiveShimRegistry } from "./live.js";

describe("net seam", () => {
  it("connect() falls back to the in-process LoopbackTransport when no backend is registered", async () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const net = registry.net as {
      connect: (options: { port: number }) => {
        on: (event: string, fn: (err: Error & { code?: string }) => void) => void;
      };
    };

    const socket = net.connect({ port: 1 });
    const err = await new Promise<Error & { code?: string }>((resolve) =>
      socket.on("error", resolve),
    );
    expect(err.code).toBe("ECONNREFUSED");
  });

  it("Server.listen() works on the default LoopbackTransport", async () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const net = registry.net as {
      createServer: () => {
        listen: (options: { port: number }, cb?: () => void) => unknown;
        address: () => unknown;
        close: (cb?: () => void) => void;
      };
    };

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0 }, resolve));
    expect((server.address() as { port: number }).port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
