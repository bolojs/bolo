import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
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

  it("resolves subpath and newly-routed builtins through createRequire", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const require = (
      registry.module as { createRequire: (f: string) => (s: string) => unknown }
    ).createRequire("/entry.ts");

    expect(require("node:fs/promises")).toBe(
      (registry.fs as { promises: unknown }).promises,
    );
    expect(require("node:dns/promises")).toBe(
      (registry.dns as { promises: unknown }).promises,
    );
    expect(require("node:assert/strict")).toBe(
      (registry.assert as { strict: unknown }).strict,
    );
    expect(require("node:stream/promises")).toBe(
      (registry.stream as { promises: unknown }).promises,
    );
    expect(require("node:util/types")).toBe(
      (registry.util as { types: unknown }).types,
    );
    expect(require("node:path/posix")).toBe(
      (registry.path as { posix: unknown }).posix,
    );
    expect(require("node:path/win32")).toBe(
      (registry.path as { win32: unknown }).win32,
    );
    expect(require("node:readline/promises")).toBeDefined();
    expect(require("node:timers/promises")).toBe(registry["timers/promises"]);
    expect(require("node:crypto")).toBe(registry.crypto);
    expect(require("node:console")).toBe(registry.console);
    expect(require("node:module")).toBe(registry.module);
  });

  it("routes the console shim through process stdout/stderr", () => {
    const vfs = new VfsBus();
    const out: string[] = [];
    const err: string[] = [];
    const registry = createLiveShimRegistry({
      vfs,
      onStdout: (d) => out.push(d),
      onStderr: (d) => err.push(d),
    });
    const console = registry.console as Record<string, (...a: never[]) => void>;

    console.log("hello", "world");
    console.warn("oops");
    console.count("hits");
    console.count("hits");
    console.time("t");
    console.timeLog("t", "checkpoint");
    console.timeEnd("t");
    console.group("g");
    console.log("nested");
    console.groupEnd();

    expect(out.join("")).toContain("hello world\n");
    expect(err.join("")).toContain("oops\n");
    expect(out.join("")).toContain("hits: 1\n");
    expect(out.join("")).toContain("hits: 2\n");
    expect(out.join("")).toMatch(/t: \d+\.\d+ms/);
    expect(out.join("")).toContain("  nested\n");

    // `new Console(stream)` binds to the supplied sink, not process stdio.
    const Console = console.Console as unknown as new (s: {
      write: (d: string) => void;
    }) => { log: (...a: unknown[]) => void };
    const custom: string[] = [];
    const own = new Console({ write: (d: string) => custom.push(d) });
    own.log("custom");
    expect(custom.join("")).toContain("custom\n");
    expect(out.join("")).not.toContain("custom");
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

  it("gives each registry its own timers object — patching one leaks nowhere", () => {
    const vfs = new VfsBus();
    const regA = createLiveShimRegistry({ vfs });
    const regB = createLiveShimRegistry({ vfs: new VfsBus() });

    const timersA = regA.timers as Record<string, unknown>;
    const timersB = regB.timers as Record<string, unknown>;
    expect(timersA).not.toBe(timersB);
    // Same surface — the copy preserves every unenv export.
    expect(Object.keys(timersA).sort()).toEqual(Object.keys(timersB).sort());
    expect(typeof timersA.setTimeout).toBe("function");

    // What the process worker does: Object.assign(shims.timers, trackedTimers).
    const trackedSetTimeout = () => "tracked";
    Object.assign(timersA, { setTimeout: trackedSetTimeout });

    // Other containers — and the shared unenv singleton behind them — keep
    // the original implementation (no cross-process contamination).
    expect(timersA.setTimeout).toBe(trackedSetTimeout);
    expect(timersB.setTimeout).not.toBe(trackedSetTimeout);
  });

  it("process.getBuiltinModule resolves builtins from the live registry", () => {
    const vfs = new VfsBus();
    const registry = createLiveShimRegistry({ vfs });
    const proc = registry.process as {
      getBuiltinModule: (name: string) => unknown;
    };

    expect(proc.getBuiltinModule("fs")).toBe(registry.fs);
    expect(proc.getBuiltinModule("node:fs")).toBe(registry.fs);
    expect(proc.getBuiltinModule("node:timers")).toBe(registry.timers);
    expect(proc.getBuiltinModule("process")).toBe(registry.process);
    // Subpath builtins: "fs/promises" → fs.promises; "timers/promises" is its
    // own registry key.
    expect(proc.getBuiltinModule("fs/promises")).toBe(
      (registry.fs as { promises: unknown }).promises,
    );
    expect(proc.getBuiltinModule("timers/promises")).toBe(registry["timers/promises"]);
    expect(proc.getBuiltinModule("not_a_builtin")).toBeUndefined();
  });
});
