import querystring from "unenv/node/querystring";
export * from "unenv/node/querystring";

export const createQuerystringShim = (): typeof querystring => {
  return querystring;
};

export default createQuerystringShim();
