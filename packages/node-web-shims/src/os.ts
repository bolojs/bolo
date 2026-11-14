import unenvOsDefault from "unenv/node/os";

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
