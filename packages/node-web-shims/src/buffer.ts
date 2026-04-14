// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/buffer/index.mjs";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import buffer from "unenv/runtime/node/buffer/index.mjs";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
