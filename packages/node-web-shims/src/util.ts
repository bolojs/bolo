import util from "unenv/node/util";
export * from "unenv/node/util";

export const createUtilShim = (): typeof util => {
  return util;
};

export default createUtilShim();
