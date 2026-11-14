import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createLiveShimRegistry } from "./live.js";

describe("tls seam", () => {
  it("routes tls.connect() through a host-registered tls backend", () => {
    const seen: unknown[] = [];
    const socket = {
      on: () => socket,
      write: () => true,
      end: () => socket,
    };
    const registry = createLiveShimRegistry({
      vfs: new VfsBus(),
      tlsBackend: () => ({
        connect: (options, listener) => {
          seen.push(options);
          listener?.();
          return socket;
        },
      }),
    });

    const tls = registry.tls as {
      connect: (port: number, options: object, cb: () => void) => unknown;
    };
    const result = tls.connect(8443, { host: "example.com" }, () => {});
    expect(result).toBe(socket);
    expect(seen[0]).toMatchObject({ port: 8443, host: "example.com" });
  });

  it("keeps the honest unsupported error when no backend is registered", () => {
    const registry = createLiveShimRegistry({ vfs: new VfsBus() });
    const tls = registry.tls as { connect: (port: number) => unknown };
    let error: (Error & { code?: string }) | undefined;
    try {
      tls.connect(8443);
    } catch (err) {
      error = err as Error & { code?: string };
    }
    expect(error?.code).toBe("ERR_BOL_UNSUPPORTED_TLS_BACKEND");
  });

  it("validates the port before consulting the backend", () => {
    const registry = createLiveShimRegistry({ vfs: new VfsBus() });
    const tls = registry.tls as { connect: (port: number) => unknown };
    expect(() => tls.connect(-1)).toThrow(/Port should be >= 0/);
  });
});
