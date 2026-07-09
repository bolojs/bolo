import zlib from "unenv/node/zlib";
export * from "unenv/node/zlib";

export const createZlibShim = (): typeof zlib => {
  return zlib;
};

export default createZlibShim();
