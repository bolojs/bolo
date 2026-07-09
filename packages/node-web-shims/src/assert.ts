import assert from "unenv/node/assert";
export * from "unenv/node/assert";

export const createAssertShim = (): typeof assert => {
  return assert;
};

export default createAssertShim();
