import type { Plugin } from "vite";

export const nodeRuntimeShims = (_options: { vfs: unknown; sandbox: unknown }): Plugin => {
  return {
    name: "node-runtime-shims",
    resolveId(id: string): string | null {
      // ponytail: https reuses the http shim verbatim; fetch handles TLS. No separate code path.
      if (
        id === "node:fs" ||
        id === "node:fs/promises" ||
        id === "node:http" ||
        id === "node:https" ||
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
const fs = createFsShim(globalThis.__vfsBus);
export default fs;
export const {
  appendFile, appendFileSync, access, accessSync, chown, chownSync, chmod, chmodSync,
  close, closeSync, copyFile, copyFileSync, cp, cpSync, createReadStream, createWriteStream,
  exists, existsSync, fchown, fchownSync, fchmod, fchmodSync, fdatasync, fdatasyncSync,
  fstat, fstatSync, fsync, fsyncSync, ftruncate, ftruncateSync, futimes, futimesSync,
  lchmod, lchmodSync, lchown, lchownSync, link, linkSync, lstat, lstatSync,
  lutimes, lutimesSync, mkdir, mkdirSync, mkdtemp, mkdtempSync, open, openSync,
  opendir, opendirSync, readdir, readdirSync, readFile, readFileSync, readlink, readlinkSync,
  realpath, realpathSync, rename, renameSync, rm, rmSync, rmdir, rmdirSync,
  stat, statSync, statfs, statfsSync, symlink, symlinkSync, truncate, truncateSync,
  unlink, unlinkSync, utimes, utimesSync, watch, watchFile, unwatchFile, writeFile, writeFileSync,
  promises, constants
} = fs;`;
      }
      if (id === "node:fs/promises") {
        return `import { createFsShim } from '@bolojs/node-runtime-shims/dist/fs-shim.js';
const fs = createFsShim(globalThis.__vfsBus);
export default fs.promises;
export const {
  access, appendFile, chmod, chown, copyFile, cp, lchmod, lchown, link, lstat, lutimes,
  mkdir, mkdtemp, open, opendir, readdir, readFile, readlink, realpath, rename, rmdir,
  stat, statfs, symlink, truncate, unlink, utimes, watch, writeFile, constants
} = fs.promises;`;
      }
      if (id === "node:http") {
        return `import { createHttpShim } from '@bolojs/node-runtime-shims/dist/http-shim.js';
const http = createHttpShim(globalThis.__sandbox, globalThis.__httpShimOptions);
export default http;
export const {
  createServer, Server, request, get, ClientRequest, IncomingMessage, ServerResponse,
  OutgoingMessage, Agent, globalAgent, createAgent, METHODS, STATUS_CODES, maxHeaderSize,
  validateHeaderName, validateHeaderValue, setMaxIdleHTTPParsers
} = http;`;
      }
      if (id === "node:https") {
        return `import { createHttpShim } from '@bolojs/node-runtime-shims/dist/http-shim.js';
const https = createHttpShim(globalThis.__sandbox, globalThis.__httpShimOptions);
export default https;
export const {
  createServer, Server, request, get, ClientRequest, IncomingMessage, ServerResponse,
  OutgoingMessage, Agent, globalAgent, createAgent, METHODS, STATUS_CODES, maxHeaderSize,
  validateHeaderName, validateHeaderValue, setMaxIdleHTTPParsers
} = https;`;
      }
      if (id === "node:net") {
        return `import { createNetShim } from '@bolojs/node-runtime-shims/dist/net-shim.js';
const netOptions = { tcpRelay: globalThis.__tcpRelay, onPortEvent: globalThis.__httpShimOptions?.onPortEvent };
const net = globalThis.__netBackend ?? createNetShim(globalThis.__sandbox, netOptions);
export default net;
export const { createServer, connect, createConnection, Server, Socket, isIP, isIPv4, isIPv6 } = net;`;
      }
      if (id === "node:child_process") {
        return `import { createChildProcessShim } from '@bolojs/node-runtime-shims/dist/child-process-shim.js';
const cp = createChildProcessShim(globalThis.__wasmRegistry, globalThis.__shellService);
export default cp;
export const { spawn, exec, execFile, fork, execSync, execFileSync, spawnSync, ChildProcess } = cp;`;
      }
      if (id === "node:dns") {
        return `import { createDnsShim } from '@bolojs/node-runtime-shims/dist/dns-shim.js';
const dns = createDnsShim();
export default dns;
export const {
  lookup, lookupService, resolve, resolve4, resolve6, resolveCname, resolveMx, resolveNs,
  resolveTxt, resolveSrv, resolvePtr, reverse, getServers, setServers,
  setDefaultResultOrder, getDefaultResultOrder, Resolver, ADDRCONFIG, V4MAPPED, ALL, promises
} = dns;`;
      }
      if (id === "node:vm") {
        return `import { createVmShim } from '@bolojs/node-runtime-shims/dist/vm-shim.js';
const vm = createVmShim();
export default vm;
export const {
  createContext, isContext, runInContext, runInNewContext, runInThisContext, compileFunction, Script
} = vm;`;
      }
      return null;
    },
  };
};
