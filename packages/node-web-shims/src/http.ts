// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/http/index.mjs";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import http from "unenv/runtime/node/http/index.mjs";

export const createHttpShim = (): typeof http => {
  return http;
};

export default createHttpShim();
