import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import { createLiveShimRegistry } from "./live.js";

const EXPECTED_CONNECT_ERROR =
  "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.pages.dev/docs/shim-coverage";

describe("net seam", () => {
  it("throws the documented error when connect() is called with no custom net backend", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const net = registry.net as { connect: (options: { port: number }) => unknown };

    expect(() => net.connect({ port: 80 })).toThrow(EXPECTED_CONNECT_ERROR);
  });

  it("preserves net.createServer() via the http shim path with no custom backend", () => {
    const vfs = new VfsBus();
    const sandbox = { onFetch: () => {} } as unknown as Parameters<
      typeof createLiveShimRegistry
    >[0]["sandbox"];
    const registry = createLiveShimRegistry({ vfs, sandbox });
    const net = registry.net as {
      createServer: (handler: unknown) => { listen: (port: number) => unknown };
    };

    const server = net.createServer((_req: unknown, res: { end: (chunk: string) => void }) =>
      res.end("net"),
    );
    expect(() => server.listen(0)).not.toThrow();
  });
});
