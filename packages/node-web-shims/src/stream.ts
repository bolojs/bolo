// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/stream/index.mjs";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import stream from "unenv/runtime/node/stream/index.mjs";

export const createStreamShim = (): typeof stream => {
  return stream;
};

export default createStreamShim();
