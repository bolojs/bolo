// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import http from "unenv/runtime/node/http";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/http";

export const createHttpShim = (): typeof http => {
  return http;
};

export default createHttpShim();
