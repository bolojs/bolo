import punycode from "unenv/node/punycode";
export * from "unenv/node/punycode";

export const createPunycodeShim = (): typeof punycode => {
  return punycode;
};

export default createPunycodeShim();
