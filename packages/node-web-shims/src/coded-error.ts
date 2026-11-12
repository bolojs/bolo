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
