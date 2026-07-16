import type { Plugin } from "vite";

export const nodeRuntimeShims = (_options: { vfs: unknown; sandbox: unknown }): Plugin => {
  return {
    name: "node-runtime-shims",
    resolveId(id: string): string | null {
      if (
        id === "node:fs" ||
        id === "node:fs/promises" ||
        id === "node:http" ||
        id === "node:net" ||
        id === "node:child_process" ||
        id === "node:dns" ||
        id === "node:vm"
      ) {
        return id;
      }
      return null;
    },
    load(id: string): string | null {
      if (id === "node:fs") {
        return `import { createFsShim } from '@bolojs/node-runtime-shims/dist/fs-shim.js';
export default createFsShim(globalThis.__vfsBus);`;
      }
      if (id === "node:fs/promises") {
        return `import { createFsShim } from '@bolojs/node-runtime-shims/dist/fs-shim.js';
const fs = createFsShim(globalThis.__vfsBus);
export const { readFile, writeFile, mkdir, rm, readdir, exists, stat } = fs.promises;`;
      }
      if (id === "node:http") {
        return `import { createHttpShim } from '@bolojs/node-runtime-shims/dist/http-shim.js';
export const { createServer, request, get, ClientRequest, IncomingMessage, ServerResponse, Agent, globalAgent, createAgent } = createHttpShim(globalThis.__sandbox, globalThis.__httpShimOptions);`;
      }
      if (id === "node:net") {
        return `import { createNetShim } from '@bolojs/node-runtime-shims/dist/http-shim.js';
const net = globalThis.__netBackend ?? createNetShim(globalThis.__sandbox, globalThis.__httpShimOptions);
export const { createServer, connect, Socket, isIP } = net;`;
      }
      if (id === "node:child_process") {
        return `import { createChildProcessShim } from '@bolojs/node-runtime-shims/dist/child-process-shim.js';
export const { spawn, exec } = createChildProcessShim(globalThis.__wasmRegistry, globalThis.__shellService);`;
      }
      if (id === "node:dns") {
        return `import { createDnsShim } from '@bolojs/node-runtime-shims/dist/dns-shim.js';
const dns = createDnsShim();
export const { lookup, resolve4, resolve6, reverse } = dns;`;
      }
      if (id === "node:vm") {
        return `import { createVmShim } from '@bolojs/node-runtime-shims/dist/vm-shim.js';
const { runInNewContext, runInThisContext, compileFunction } = createVmShim();
export { runInNewContext, runInThisContext, compileFunction };`;
      }
      return null;
    },
  };
};
