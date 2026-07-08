import http from "unenv/node/http";
export * from "unenv/node/http";

export const createHttpShim = (): typeof http => {
  return http;
};

export default createHttpShim();
