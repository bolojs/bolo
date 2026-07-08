// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import util from "unenv/runtime/node/util";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/util";

export const createUtilShim = (): typeof util => {
  return util;
};

export default createUtilShim();
