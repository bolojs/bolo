// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/os/index.mjs";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import os from "unenv/runtime/node/os/index.mjs";

export const createOsShim = (): typeof os => {
  return os;
};

export default createOsShim();
