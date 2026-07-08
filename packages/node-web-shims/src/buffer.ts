import buffer from "unenv/node/buffer";
export * from "unenv/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
