import perf_hooks from "unenv/node/perf_hooks";
export * from "unenv/node/perf_hooks";

export const createPerfHooksShim = (): typeof perf_hooks => {
  return perf_hooks;
};

export default createPerfHooksShim();
