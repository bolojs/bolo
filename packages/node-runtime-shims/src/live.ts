import type { VfsBus } from "@browser-containers/vfs-bus";
import type { SWSandbox } from "@browser-containers/sw-sandbox";
import * as nodeWebShims from "@browser-containers/node-web-shims";
import { installUnhandledRejectionHandler } from "@browser-containers/node-web-shims";
import { createFsShim } from "./fs-shim.js";
import { createHttpShim } from "./http-shim.js";
import {
  createChildProcessShim,
  type WasmRegistry,
  type ShellService,
} from "./child-process-shim.js";
import { createProcessShim, type ProcessShim } from "./process-shim.js";
import { createModuleShim } from "./module-shim.js";
import { createDnsShim } from "./dns-shim.js";
import { createVmShim } from "./vm-shim.js";

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
}

/**
 * Builds the map of node builtin name -> live shim instance for the current
 * container (bound to its own `VfsBus`/`SWSandbox`). A bundled user app reads
 * this map at run time via `globalThis.__browserContainers.shims` — see
 * `bundleEntry`'s node-alias plugin in `@browser-containers/wasm-registry`.
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
  installUnhandledRejectionHandler(
    ((reason: unknown, promise: unknown) => processShim.emit("unhandledRejection", reason, promise)) as (
      reason: unknown,
      promise: unknown,
    ) => void,
  );

  registry.module = createModuleShim({ vfs: options.vfs, getShim: (name) => registry[name] });

  const http = createHttpShim(options.sandbox, { onPortEvent: options.onPortEvent });
  registry.http = http;
  registry.net = http;

  return registry;
};
