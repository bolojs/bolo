import unenvOsDefault from "unenv/node/os";

export * from "unenv/node/os";

// unenv types its default export as `{}` — assert the real module shape.
const unenvOs = unenvOsDefault as unknown as typeof import("node:os");

// `EOL` must stay configurable — Node defines it with
// `{ writable: false, enumerable: true, configurable: true }` and the compat
// suite redefines it (unenv ships it as a plain const, which froze the shim's
// namespace and threw `Cannot redefine property: EOL`).
let eolValue: string = unenvOs.EOL;

const nav = (): Navigator | undefined => (globalThis as { navigator?: Navigator }).navigator;

const cpuCount = (): number => nav()?.hardwareConcurrency || 8;

const os = {
  ...unenvOs,
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
  get: () => eolValue,
  set: (v: string) => {
    eolValue = v;
  },
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
