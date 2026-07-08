// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import asyncHooks from "unenv/runtime/node/async_hooks";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/async_hooks";

export const createAsyncHooksShim = (): typeof asyncHooks => {
  return asyncHooks;
};

export default createAsyncHooksShim();
