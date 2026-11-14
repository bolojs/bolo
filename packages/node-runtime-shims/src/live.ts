import type { VfsBus } from "@bolojs/fs";
import type { SWSandbox } from "@bolojs/sandbox";
import * as nodeWebShims from "@bolojs/node-web-shims";
import { installUnhandledRejectionHandler, createDgramShim } from "@bolojs/node-web-shims";
import { createFsShim } from "./fs-shim.js";
import { createHttpShim } from "./http-shim.js";
import { createNetShim } from "./net-shim.js";
import {
  createChildProcessShim,
  type SyncRunner,
  type WasmRegistry,
  type ShellService,
} from "./child-process-shim.js";
import { createProcessShim, type ProcessShim } from "./process-shim.js";
import {
  createWorkerThreadsBackend,
  spawnedProcessToWorkerLike,
  type ProcessSpawner,
  type WorkerThreadInfo,
} from "./worker-threads-shim.js";
import { createModuleShim } from "./module-shim.js";
import { createDnsShim } from "./dns-shim.js";
import { getSystemErrorName } from "./errno.js";
import { resolveBackend, registration } from "./backend-registry.js";
import { createLoopbackDgramBackend } from "./dgram-backend.js";
import type { DgramSocketBackend } from "@bolojs/node-web-shims";

interface WriteSink {
  write: (data: string) => unknown;
}

/**
 * `node:console` as a registry shim — the same surface the bundler's banner
 * console exposes, but routed through the container's process stdout/stderr
 * so `createRequire("x")("node:console")` and `import "node:console"` see the
 * same object shape. `Console` is the per-stream constructor from Node; the
 * module-level object is the default instance bound to process stdio.
 */
const createConsoleShim = (proc: ProcessShim): Record<string, unknown> => {
  const utilFormat = (nodeWebShims.util as { format?: (...a: unknown[]) => string }).format;
  const fmt = (args: unknown[]): string =>
    utilFormat ? utilFormat(...args) : args.map(String).join(" ");

  const make = (out?: WriteSink, err?: WriteSink): Record<string, unknown> => {
    const counts = new Map<string, number>();
    const times = new Map<string, number>();
    let indent = 0;
    const now = (): number => globalThis.performance?.now?.() ?? Date.now();
    const write = (stream: "stdout" | "stderr", args: unknown[]): void => {
      const sink = (stream === "stderr" ? err : out) ?? proc[stream];
      sink?.write?.(`${"  ".repeat(indent)}${fmt(args)}\n`);
    };
    const labelTime = (label: string): number | undefined => {
      const start = times.get(label);
      return start === undefined ? undefined : now() - start;
    };
    return {
      log: (...a: unknown[]) => write("stdout", a),
      info: (...a: unknown[]) => write("stdout", a),
      debug: (...a: unknown[]) => write("stdout", a),
      table: (...a: unknown[]) => write("stdout", a),
      dir: (obj: unknown) => write("stdout", [obj]),
      dirxml: (obj: unknown) => write("stdout", [obj]),
      warn: (...a: unknown[]) => write("stderr", a),
      error: (...a: unknown[]) => write("stderr", a),
      trace: (...a: unknown[]) => write("stderr", ["Trace:", ...a]),
      assert: (cond: unknown, ...a: unknown[]) => {
        if (!cond) write("stderr", [`Assertion failed${a.length ? ":" : ""}`, ...a]);
      },
      clear: () => {},
      count: (label = "default") => {
        // Implicit coercion throws TypeError on Symbol labels, matching
        // node:console (test-console-count).
        label = "" + label;
        const n = (counts.get(label) ?? 0) + 1;
        counts.set(label, n);
        write("stdout", [`${label}: ${n}`]);
      },
      countReset: (label = "default") => {
        label = "" + label;
        counts.delete(label);
      },
      time: (label = "default") => {
        times.set(label, now());
      },
      timeEnd: (label = "default") => {
        const ms = labelTime(label);
        if (ms === undefined) {
          write("stderr", [`Warning: No such label '${label}' for console.timeEnd()`]);
          return;
        }
        times.delete(label);
        write("stdout", [`${label}: ${ms.toFixed(3)}ms`]);
      },
      timeLog: (label = "default", ...a: unknown[]) => {
        const ms = labelTime(label);
        if (ms === undefined) {
          write("stderr", [`Warning: No such label '${label}' for console.timeLog()`]);
          return;
        }
        write("stdout", [`${label}: ${ms.toFixed(3)}ms`, ...a]);
      },
      group: (...a: unknown[]) => {
        if (a.length) write("stdout", a);
        indent++;
      },
      groupCollapsed: (...a: unknown[]) => {
        if (a.length) write("stdout", a);
        indent++;
      },
      groupEnd: () => {
        if (indent > 0) indent--;
      },
      // `new Console(stdout, stderr)` returns the object built here — the
      // constructor return value wins, so instances get the same own-key
      // surface as the module (all methods enumerable for Object.keys-based
      // bundler re-export).
      Console: class {
        constructor(o?: WriteSink, e?: WriteSink) {
          return make(o, e);
        }
      },
    };
  };
  return make(proc.stdout, proc.stderr);
};

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
}

export interface StreamBackend {
  connect(options: NetConnectOptions, connectionListener?: () => void): StreamSocket;
  isIP(input: string): number;
}

/**
 * The dgram capability seam. A host registers a factory; each
 * `dgram.createSocket()` call gets a fresh backend socket handle.
 */
export type DgramBackend = (deps: BackendDeps) => DgramBackendFactory;

export interface DgramBackendFactory {
  createSocket(
    type: "udp4" | "udp6",
    callback?: (msg: Uint8Array, rinfo: { address: string; port: number }) => void,
  ): DgramSocketBackend;
}
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
  readonly tcpRelay?: { url: string };
  readonly dohEndpoint?: string;
  /**
   * Spawn a bundled-code process worker — backs both `worker_threads.Worker`
   * and `child_process.fork`/worker-spawn. Supplied by the host that can
   * reach a real Worker (main thread: NodeProcess; process worker: rpc).
   */
  readonly spawnProcess?: ProcessSpawner;
  /**
   * Blocking child-run backend for `child_process.spawnSync`/`execSync`/
   * `execFileSync`. Inside a process worker this rides the sync channel
   * (`child.runSync` op — the main thread runs the child to completion and
   * ships buffered stdio back). Absent a backend the sync APIs keep throwing
   * the documented unsupported error.
   */
  readonly spawnSyncProcess?: SyncRunner;
  /** Present when this registry runs INSIDE a spawned worker thread. */
  readonly workerThread?: WorkerThreadInfo;
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
 * `bundleEntry`'s node-alias plugin in `@bolojs/registry`.
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
    // node-web-shims' util leaves getSystemErrorName unimplemented; the
    // errno table lives here so child_process/fs error metadata can name
    // libuv codes the same way Node does.
    util: { ...nodeWebShims.util, getSystemErrorName },
    async_hooks: nodeWebShims.async_hooks,
    querystring: nodeWebShims.querystring,
    worker_threads: createWorkerThreadsBackend({
      spawnProcess: options.spawnProcess,
      thread: options.workerThread,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    }),
    string_decoder: nodeWebShims.string_decoder,
    tty: nodeWebShims.tty,
    assert: nodeWebShims.assert,
    zlib: nodeWebShims.zlib,
    constants: nodeWebShims.constants,
    perf_hooks: nodeWebShims.perf_hooks,
    // Per-registry copy, not the module-level unenv singleton: the process
    // worker patches this object with its loop-backed tracked timers via
    // `Object.assign(shims.timers, trackedTimers)` (node-process-worker.ts).
    // Assigning onto the shared singleton would leak one process's timers
    // into every other container in this realm (last-process-wins).
    timers: { ...nodeWebShims.timers },
    "timers/promises": nodeWebShims.timers_promises,
    punycode: nodeWebShims.punycode,
    diagnostics_channel: nodeWebShims.diagnostics_channel,
    readline: nodeWebShims.readline,
    v8: nodeWebShims.v8,
    http2: nodeWebShims.http2,
    domain: nodeWebShims.domain,
    // dgram/tls get a real single-process skeleton here; a host with a true
    // backend (options.dgramBackend/tlsBackend) overrides below.
    dgram: nodeWebShims.dgram,
    tls: nodeWebShims.tls,
    cluster: nodeWebShims.cluster,
    repl: nodeWebShims.repl,
    inspector: nodeWebShims.inspector,
    trace_events: nodeWebShims.trace_events,
    // node-web-shims' realm-local contextification (sandbox object identity
    // across the boundary); the QuickJS-backed createVmShim cannot reflect
    // defineProperty writes back onto the caller's sandbox object.
    vm: nodeWebShims.vm,
    dns: createDnsShim({ dohEndpoint: options.dohEndpoint }),
    fs: createFsShim(options.vfs),
    child_process: createChildProcessShim(
      options.wasmRegistry,
      options.shellService,
      options.spawnProcess
        ? {
            createWorker: (spec) => {
              const proc = options.spawnProcess!({
                filename: spec.filename,
                code: spec.code,
                args: spec.args,
                env: spec.env,
                cwd: spec.cwd,
              });
              return proc ? spawnedProcessToWorkerLike(proc) : undefined;
            },
          }
        : undefined,
      options.spawnSyncProcess,
    ),
  };

  const processShim = createProcessShim({
    cwd: options.cwd,
    argv: options.argv,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    // `process.getBuiltinModule("fs/promises")` and friends: try the
    // registry key first ("timers/promises" is a real key), then walk the
    // "<top>/<sub>" path off the top-level shim ("fs/promises" → fs.promises,
    // "path/posix" → path.posix), falling back to the top-level shim —
    // closest analogue of Node's builtin-module table.
    getBuiltinModule: (name) => {
      const bare = name.startsWith("node:") ? name.slice("node:".length) : name;
      if (registry[bare] !== undefined) return registry[bare];
      const [top, ...sub] = bare.split("/");
      let mod = registry[top] as Record<string, unknown> | undefined;
      for (const key of sub) {
        mod = mod?.[key] as Record<string, unknown> | undefined;
        if (mod === undefined) return registry[top];
      }
      return mod;
    },
  }) as ProcessShim;

  registry.process = processShim;
  registry.console = createConsoleShim(processShim);
  installUnhandledRejectionHandler(((reason: unknown, promise: unknown) =>
    processShim.emit("unhandledRejection", reason, promise)) as (
    reason: unknown,
    promise: unknown,
  ) => void);

  const backendDeps: BackendDeps = { vfs: options.vfs, sandbox: options.sandbox };

  // Seam resolution is declarative: an ordered candidate list, first present
  // candidate wins (see backend-registry.ts). The explicit host-provided
  // backend always outranks the built-in skeleton.
  // Dgram precedence: host backend, then the in-realm loopback backend
  // (the node:dgram equivalent of net's LoopbackTransport). Without any
  // backend the honest skeleton stays (send reports
  // ERR_BOL_UNSUPPORTED_DGRAM_BACKEND through the callback).
  const dgramResolved = resolveBackend(
    [
      options.dgramBackend ? registration("host-dgram", options.dgramBackend) : undefined,
      registration("dgram-loopback", () => createLoopbackDgramBackend()),
    ],
    backendDeps,
  );
  if (dgramResolved) {
    const factory = dgramResolved.backend;
    registry.dgram = createDgramShim({
      createBackend: (type) => factory.createSocket(type),
    });
  }

  const tlsResolved = resolveBackend(
    [options.tlsBackend ? registration("host-tls", options.tlsBackend) : undefined],
    backendDeps,
  );
  if (tlsResolved) registry.tls = tlsResolved.backend;
  if (options.workerThreadsBackend) {
    registry.worker_threads = options.workerThreadsBackend({
      vfs: options.vfs,
      sandbox: options.sandbox,
    });
  }

  const http = createHttpShim(options.sandbox, { onPortEvent: options.onPortEvent });
  registry.http = http;
  registry.https = http; // https delegates to http in browser context
  // Net precedence, made explicit and single-sourced:
  //   1. host-registered netBackend
  //   2. tcpRelay-derived transport (inside createNetShim)
  //   3. in-process LoopbackTransport (inside createNetShim)
  const netResolved = resolveBackend(
    [
      options.netBackend ? registration("host-net", options.netBackend) : undefined,
      // The relay-vs-loopback choice lives inside createNetShim: a configured
      // `tcpRelay` yields a WebSocketTransport, otherwise LoopbackTransport.
      registration(options.tcpRelay?.url ? "tcp-relay" : "loopback", () =>
        createNetShim(options.sandbox, {
          tcpRelay: options.tcpRelay,
          onPortEvent: options.onPortEvent,
        }),
      ),
    ],
    backendDeps,
  );
  registry.net = netResolved?.backend;

  registry.module = createModuleShim({
    vfs: options.vfs,
    getShim: (name) => registry[name],
    nativeAddonLoader: options.nativeAddonLoader,
  });

  return registry;
};
