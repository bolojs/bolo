import unenvOsDefault from "unenv/node/os";

import { getInternalBinding, registerInternalBinding } from "./internal/bindings.js";

export * from "unenv/node/os";

// unenv types its default export as `{}` — assert the real module shape.
const unenvOs = unenvOsDefault as unknown as typeof import("node:os");

// `EOL` must stay configurable — Node defines it with
// `{ writable: false, enumerable: true, configurable: true }` and the compat
// suite redefines it (unenv ships it as a plain const, which froze the shim's
// namespace and threw `Cannot redefine property: EOL`).
//
// `writable: false` is what makes `os.EOL = 123` throw a `TypeError` in
// strict-mode callers, exactly like Node: the property is a read-only value
// that can still be re-`defineProperty`'d.
const eolValue: string = unenvOs.EOL;

const nav = (): Navigator | undefined => (globalThis as { navigator?: Navigator }).navigator;

const cpuCount = (): number => nav()?.hardwareConcurrency || 8;

/**
 * The `os` internal binding. Node wraps each binding function in
 * `getCheckedFunction`: the callee fills a `ctx` object on failure and the
 * wrapper raises ERR_SYSTEM_ERROR ("A system error occurred: <syscall>
 * returned <code> (<message>)"). Tests monkey-patch binding functions (e.g.
 * `internalBinding('os').getHomeDirectory = ...`), so every checked call
 * reads the current property off the registered binding object.
 */
interface OsCallCtx {
  syscall?: string;
  code?: string;
  message?: string;
  errno?: number;
}

const systemError = (ctx: OsCallCtx): Error =>
  Object.assign(
    new Error(
      `A system error occurred: ${ctx.syscall} returned ${ctx.code} (${ctx.message})`,
    ),
    { syscall: ctx.syscall, code: ctx.code, errno: ctx.errno },
  );

type OsBindingFn = (ctx: OsCallCtx) => unknown;

const checkedOsCall = <T>(name: string): T => {
  const binding = getInternalBinding("os") as Record<string, OsBindingFn> | undefined;
  const ctx: OsCallCtx = {};
  const ret = binding?.[name]?.(ctx);
  if (ret === undefined) throw systemError(ctx);
  return ret as T;
};

const defaultHome = (): string => {
  const env = (
    globalThis as {
      __browserContainers?: { shims?: { process?: { env?: Record<string, string> } } };
    }
  ).__browserContainers?.shims?.process?.env;
  return env?.HOME ?? "/";
};

registerInternalBinding("os", {
  getHomeDirectory: (_ctx: OsCallCtx) => defaultHome(),
  getHostname: (_ctx: OsCallCtx) =>
    (globalThis as { location?: Location }).location?.hostname ?? "",
  getUptime: (_ctx: OsCallCtx) =>
    Math.floor((globalThis.performance?.now?.() ?? 0) / 1000),
  // Node fills a Float64Array out-param rather than returning a value; the
  // browser has no load signal, so report an idle system.
  getLoadAvg: (loadavg: Float64Array) => {
    loadavg[0] = loadavg[1] = loadavg[2] = 0;
  },
  getInterfaceAddresses: (_ctx: OsCallCtx) => ({}),
  getOSInformation: (_ctx: OsCallCtx) => ["Browser", "", "", ""],
  getCPUs: (_ctx: OsCallCtx) => cpuCount(),
  getAvailableParallelism: (_ctx: OsCallCtx) => cpuCount(),
  getUserInfo: (_ctx: OsCallCtx) => ({ uid: -1, gid: -1, username: "", homedir: "/", shell: null }),
  isBigEndian: (_ctx: OsCallCtx) => false,
  getFreeMem: (_ctx: OsCallCtx) => 0,
  getTotalMem: (_ctx: OsCallCtx) => 0,
  getPriority: (_ctx: OsCallCtx) => 0,
  setPriority: (_ctx: OsCallCtx) => 0,
});

/**
 * CPU architecture, Node-style ("x64", "arm64", "ia32", ...).
 *
 * unenv's `os.arch()` returns an empty string, which breaks every loader
 * that keys native-addon prebuilds off the arch (node-gyp-build's
 * "platform=linux arch= runtime=node" target string never matches a
 * prebuild). The browser has no architecture concept, but the CPU
 * fingerprint in `navigator.userAgentData` / `navigator.userAgent` is the
 * closest available signal — and it is the one package managers and
 * prebuild resolvers already use to pick a per-platform binary.
 */
const detectArch = (): string => {
  const n = nav();
  const hint = `${n?.userAgent ?? ""} ${n?.platform ?? ""}`.toLowerCase();
  if (hint.includes("aarch64") || hint.includes("arm64")) return "arm64";
  if (hint.includes("armv7") || hint.includes("armv8l") || /\barm\b/.test(hint)) return "arm";
  if (hint.includes("ia32") || hint.includes("x86")) return "ia32";
  // x64 is the overwhelmingly common desktop case; 32-bit x86 browsers
  // report "x86" in the UA, which the ia32 branch above already caught.
  return "x64";
};

const os = {
  ...unenvOs,
  arch: detectArch,
  // Node's os.homedir is a checked binding call — monkey-patching
  // internalBinding('os').getHomeDirectory changes what it throws
  // (test-os-checked-function).
  homedir: () => checkedOsCall<string>("getHomeDirectory"),
  cpus: () => {
    const info = {
      model: "",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    };
    return Array.from({ length: cpuCount() }, () => ({ ...info }));
  },
  availableParallelism: () => cpuCount(),
  hostname: () => (globalThis as { location?: Location }).location?.hostname ?? "",
  tmpdir: () => "/tmp",
};

Object.defineProperty(os, "EOL", {
  enumerable: true,
  configurable: true,
  writable: false,
  value: eolValue,
});

export const EOL = os.EOL;
export const homedir = os.homedir;
export const cpus = os.cpus;
export const availableParallelism = os.availableParallelism;
export const hostname = os.hostname;
export const tmpdir = os.tmpdir;
export const networkInterfaces = os.networkInterfaces;

/**
 * Creates a node:os shim. EOL is configurable so hosts/tests can set the
 * platform line ending; `cpus` reflects `navigator.hardwareConcurrency`.
 */
export const createOsShim = (): typeof os => {
  return os;
};

export default createOsShim();
