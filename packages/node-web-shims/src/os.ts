import os from "unenv/node/os";
export * from "unenv/node/os";

export const createOsShim = (): typeof os => {
  return os;
};

export default createOsShim();
