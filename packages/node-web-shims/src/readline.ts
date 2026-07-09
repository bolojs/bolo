import readline from "unenv/node/readline";
export * from "unenv/node/readline";

export const createReadlineShim = (): typeof readline => {
  return readline;
};

export default createReadlineShim();
