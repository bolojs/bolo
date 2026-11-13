/**
 * Attach a Node-style error code to an error while keeping `String(err)`
 * Node-shaped. Node's internal errors stringify as
 * `TypeError [ERR_INVALID_ARG_TYPE]: message` (the code rides along in the
 * name slot) but expose `err.name === "TypeError"` and `err.code` as plain
 * properties — tests match on all three.
 */
export const withCode = <E extends Error>(err: E, code: string, name?: string): E => {
  const baseName = name ?? err.name;
  Object.defineProperty(err, "name", {
    enumerable: false,
    configurable: true,
    get: () => baseName,
  });
  Object.defineProperty(err, "code", {
    value: code,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(err, "toString", {
    enumerable: false,
    configurable: true,
    writable: true,
    value: () => `${baseName} [${code}]: ${err.message}`,
  });
  return err;
};

/**
 * Error for a shim path that is structurally unsupported unless the host
 * injects the named seam/backend. The code is greppable:
 * `ERR_BOL_UNSUPPORTED_<SEAM>` where <SEAM> names the missing extension
 * point — TLS_BACKEND, DGRAM_BACKEND, NATIVE_ADDON_LOADER, NET_BACKEND,
 * SPAWN_SYNC, SPAWN_PROCESS, SPAWN_WORKER, INSPECTOR_BACKEND, ... — so an
 * agent hitting it knows exactly which `createLiveShimRegistry` option (or
 * absence of browser mapping) is responsible, instead of debugging a raw
 * "not implemented" or an undefined binding.
 */
export const unsupportedError = (seam: string, message: string): Error =>
  withCode(new Error(message), `ERR_BOL_UNSUPPORTED_${seam}`);
