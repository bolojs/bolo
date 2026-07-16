import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import { createLiveShimRegistry } from "./live.js";
import type { StreamBackend, StreamSocket } from "./live.js";

describe("createLiveShimRegistry", () => {
  it("includes stateless node-web-shims builtins, a vfs-bound fs shim, and outbound http/net client surface", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });

    expect(registry.path).toBeDefined();
    expect(registry.buffer).toBeDefined();
    expect(typeof (registry.fs as { readFile: unknown }).readFile).toBe("function");
    expect(registry.http).toBeDefined();
    expect(registry.net).toBeDefined();
    expect(registry.net).not.toBe(registry.http);

    const http = registry.http as {
      request: unknown;
      get: unknown;
      createServer: unknown;
    };
    expect(typeof http.request).toBe("function");
    expect(typeof http.get).toBe("function");
    expect(typeof http.createServer).toBe("function");

    const net = registry.net as { createServer: unknown; connect: unknown };
    expect(typeof net.createServer).toBe("function");
    expect(typeof net.connect).toBe("function");
  });

  it("includes the expanded node:* builtin set (A2)", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });

    for (const name of [
      "string_decoder",
      "tty",
      "assert",
      "zlib",
      "constants",
      "perf_hooks",
      "timers",
      "timers/promises",
      "punycode",
      "diagnostics_channel",
      "readline",
    ]) {
      expect(registry[name], `registry.${name}`).toBeDefined();
    }

    const moduleShim = registry.module as {
      createRequire: (filename: string) => (specifier: string) => unknown;
    };
    expect(typeof moduleShim.createRequire).toBe("function");
    const require = moduleShim.createRequire("/entry.ts");
    expect(require("node:path")).toBe(registry.path);
  });

  it("binds http/net to the sandbox when one is provided", () => {
    const vfs = new VfsBus();
    const sandbox = { onFetch: () => {} } as unknown as Parameters<
      typeof createLiveShimRegistry
    >[0]["sandbox"];
    const registry = createLiveShimRegistry({ vfs, sandbox });

    expect(registry.http).toBeDefined();
    expect(registry.net).toBeDefined();
    expect(registry.net).not.toBe(registry.http);
    expect(typeof (registry.net as { createServer: unknown }).createServer).toBe("function");
  });

  it("aliases https to http and supports pluggable net/dgram/tls/worker_threads backends", () => {
    const vfs = new VfsBus();
    const netShim: StreamBackend = {
      connect: () => ({ write: () => true, end: () => ({}) }) as unknown as StreamSocket,
      isIP: () => 4,
    };
    const dgramShim = { createSocket: () => {} };
    const tlsShim: StreamBackend = {
      connect: () => ({ write: () => true, end: () => ({}) }) as unknown as StreamSocket,
      isIP: () => 6,
    };
    const workerThreadsShim = { Worker: class {} };
    const registry = createLiveShimRegistry({
      vfs,
      netBackend: () => netShim,
      dgramBackend: () => dgramShim,
      tlsBackend: () => tlsShim,
      workerThreadsBackend: () => workerThreadsShim,
    });

    expect(registry.https).toBe(registry.http);
    expect(registry.net).toEqual(netShim);
    expect(registry.dgram).toBe(dgramShim);
    expect(registry.tls).toEqual(tlsShim);
    expect(registry.worker_threads).toBe(workerThreadsShim);
  });
});
