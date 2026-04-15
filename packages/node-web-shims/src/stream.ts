// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import stream from "unenv/runtime/node/stream";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/stream";

export const createStreamShim = (): typeof stream => {
  return stream;
};

export default createStreamShim();
