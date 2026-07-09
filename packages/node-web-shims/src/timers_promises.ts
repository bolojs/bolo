import timersPromises from "unenv/node/timers/promises";
export * from "unenv/node/timers/promises";

export const createTimersPromisesShim = (): typeof timersPromises => {
  return timersPromises;
};

export default createTimersPromisesShim();
