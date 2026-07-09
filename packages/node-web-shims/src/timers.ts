import timers from "unenv/node/timers";
export * from "unenv/node/timers";

export const createTimersShim = (): typeof timers => {
  return timers;
};

export default createTimersShim();
