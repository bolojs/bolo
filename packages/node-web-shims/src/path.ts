import path from "unenv/node/path";
export * from "unenv/node/path";

export const createPathShim = (): typeof path => {
  return path;
};

export default createPathShim();
