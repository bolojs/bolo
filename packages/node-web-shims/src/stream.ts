import stream from "unenv/node/stream";
export * from "unenv/node/stream";

export const createStreamShim = (): typeof stream => {
  return stream;
};

export default createStreamShim();
