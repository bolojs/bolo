import constants from "unenv/node/constants";
export * from "unenv/node/constants";

export const createConstantsShim = (): typeof constants => {
  return constants;
};

export default createConstantsShim();
