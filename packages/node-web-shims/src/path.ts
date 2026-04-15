// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import path from "unenv/runtime/node/path";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/path";

export const createPathShim = (): typeof path => {
  return path;
};

export default createPathShim();
