// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import os from "unenv/runtime/node/os";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/os";

export const createOsShim = (): typeof os => {
  return os;
};

export default createOsShim();
