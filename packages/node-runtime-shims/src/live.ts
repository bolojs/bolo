import type { VfsBus } from "@bolojs/vfs-bus";
import type { SWSandbox } from "@bolojs/sw-sandbox";
import * as nodeWebShims from "@bolojs/node-web-shims";
import { installUnhandledRejectionHandler } from "@bolojs/node-web-shims";
import { createFsShim } from "./fs-shim.js";
import { createHttpShim, createNetShim } from "./http-shim.js";
import {
  createChildProcessShim,
  type WasmRegistry,
  type ShellService,
} from "./child-process-shim.js";
import { createProcessShim, type ProcessShim } from "./process-shim.js";
import { createModuleShim } from "./module-shim.js";
import { createDnsShim } from "./dns-shim.js";
import { createVmShim } from "./vm-shim.js";

export interface BackendDeps {
  readonly vfs: VfsBus;
  readonly sandbox?: SWSandbox;
}

// Socket is a Duplex from node-web-shims' createStreamShim() — same pattern as
// http-shim.ts line 9. The shape the browser-side Socket will conform to
// (implementation arrives in Phase 1).
export interface StreamSocket {
  write(chunk: Uint8Array | string): boolean;
  end(): this;
  destroy(error?: Error): this;
  on(
    event: "data" | "close" | "error" | "end" | "drain" | "finish",
    listener: (...args: any[]) => void,
  ): this;
  setTimeout(msec: number, callback?: () => void): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  ref(): this;
  unref(): this;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
  readonly localAddress?: string;
  readonly localPort?: number;
}

export interface NetConnectOptions {
  port: number;
  host?: string;
  // tls is a config flag, NOT a separate backend (oracle decision).
  tls?: boolean;
}

// Replaces both NetBackend and TlsBackend. tls.connect() becomes StreamBackend
// with { tls: true }.
export interface StreamBackend {
  connect(options: NetConnectOptions, connectionListener?: () => void): StreamSocket;
  isIP(input: string): number;
}

export type DgramBackend = (deps: BackendDeps) => {
  createSocket(
    type: "udp4" | "udp6",
    callback?: (msg: Uint8Array, rinfo: { address: string; port: number }) => void,
  ): unknown;
};
export type WorkerThreadsBackend = (deps: BackendDeps) => unknown;
export type NativeAddonLoader = (modulePath: string, vfs: VfsBus) => unknown;

export interface LiveShimRegistryOptions {
  readonly vfs: VfsBus;
  readonly sandbox?: SWSandbox;
  readonly onPortEvent?: (event: string, data: { port: number; url?: string }) => void;
  readonly wasmRegistry?: WasmRegistry;
  readonly shellService?: ShellService;
  readonly cwd?: string;
  readonly argv?: string[];
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
  // Extension points
  readonly netBackend?: (deps: BackendDeps) => StreamBackend;
  readonly dgramBackend?: DgramBackend;
  readonly tlsBackend?: (deps: BackendDeps) => StreamBackend;
  readonly workerThreadsBackend?: WorkerThreadsBackend;
  readonly nativeAddonLoader?: NativeAddonLoader;
}

/**
 * Builds the map of node builtin name -> live shim instance for the current
 * container (bound to its own `VfsBus`/`SWSandbox`). A bundled user app reads
 * this map at run time via `globalThis.__browserContainers.shims` — see
 * `bundleEntry`'s node-alias plugin in `@bolojs/wasm-registry`.
 */
export const createLiveShimRegistry = (
  options: LiveShimRegistryOptions,
): Record<string, unknown> => {
  const registry: Record<string, unknown> = {
    path: nodeWebShims.path,
    buffer: nodeWebShims.buffer,
    url: nodeWebShims.url,
    crypto: nodeWebShims.crypto,
    os: nodeWebShims.os,
    events: nodeWebShims.events,
    stream: nodeWebShims.stream,
    util: nodeWebShims.util,
    async_hooks: nodeWebShims.async_hooks,
    querystring: nodeWebShims.querystring,
    worker_threads: nodeWebShims.worker_threads,
    string_decoder: nodeWebShims.string_decoder,
    tty: nodeWebShims.tty,
    assert: nodeWebShims.assert,
    zlib: nodeWebShims.zlib,
    constants: nodeWebShims.constants,
    perf_hooks: nodeWebShims.perf_hooks,
    timers: nodeWebShims.timers,
    "timers/promises": nodeWebShims.timers_promises,
    punycode: nodeWebShims.punycode,
    diagnostics_channel: nodeWebShims.diagnostics_channel,
    readline: nodeWebShims.readline,
    vm: createVmShim(),
    dns: createDnsShim(),
    fs: createFsShim(options.vfs),
    child_process: createChildProcessShim(options.wasmRegistry, options.shellService),
  };

  const processShim = createProcessShim({
    cwd: options.cwd,
    argv: options.argv,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  }) as ProcessShim;

  registry.process = processShim;
  installUnhandledRejectionHandler(((reason: unknown, promise: unknown) =>
    processShim.emit("unhandledRejection", reason, promise)) as (
    reason: unknown,
    promise: unknown,
  ) => void);

  if (options.dgramBackend) {
    registry.dgram = options.dgramBackend({ vfs: options.vfs, sandbox: options.sandbox });
  }
  if (options.tlsBackend) {
    registry.tls = options.tlsBackend({ vfs: options.vfs, sandbox: options.sandbox });
  }
  if (options.workerThreadsBackend) {
    registry.worker_threads = options.workerThreadsBackend({
      vfs: options.vfs,
      sandbox: options.sandbox,
    });
  }

  const http = createHttpShim(options.sandbox, { onPortEvent: options.onPortEvent });
  registry.http = http;
  registry.https = http; // https delegates to http in browser context
  registry.net = options.netBackend
    ? options.netBackend({ vfs: options.vfs, sandbox: options.sandbox })
    : createNetShim(options.sandbox, { onPortEvent: options.onPortEvent });

  registry.module = createModuleShim({
    vfs: options.vfs,
    getShim: (name) => registry[name],
    nativeAddonLoader: options.nativeAddonLoader,
  });

  return registry;
};
