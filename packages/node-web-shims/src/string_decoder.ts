import string_decoder from "unenv/node/string_decoder";
export * from "unenv/node/string_decoder";

export const createStringDecoderShim = (): typeof string_decoder => {
  return string_decoder;
};

export default createStringDecoderShim();
