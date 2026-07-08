import asyncHooks from "unenv/node/async_hooks";
export * from "unenv/node/async_hooks";

export const createAsyncHooksShim = (): typeof asyncHooks => {
  return asyncHooks;
};

export default createAsyncHooksShim();
