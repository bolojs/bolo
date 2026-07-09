import tty from "unenv/node/tty";
export * from "unenv/node/tty";

export const createTtyShim = (): typeof tty => {
  return tty;
};

export default createTtyShim();
