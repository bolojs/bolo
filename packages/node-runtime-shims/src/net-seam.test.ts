import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import { createLiveShimRegistry } from "./live.js";

const EXPECTED_CONNECT_ERROR =
  "net.connect requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage";

describe("net seam", () => {
  it("throws the documented error when connect() is called with no custom net backend", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const net = registry.net as { connect: (options: { port: number }) => unknown };

    expect(() => net.connect({ port: 80 })).toThrow(EXPECTED_CONNECT_ERROR);
  });

  it("throws the documented error when Server.listen() is called with no custom backend", async () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const net = registry.net as {
      createServer: () => { listen: (port: number) => Promise<unknown> };
    };

    const server = net.createServer();
    await expect(server.listen(0)).rejects.toThrow(
      "net.Server.listen requires a StreamBackend (TCP relay). Register one via createLiveShimRegistry({ netBackend }) or configure a tcpRelay. See: https://bolojs.dev/docs/shim-coverage",
    );
  });
});
