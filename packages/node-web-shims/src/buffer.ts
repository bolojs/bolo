// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import buffer from "unenv/runtime/node/buffer";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
