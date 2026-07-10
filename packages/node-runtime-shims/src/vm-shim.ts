import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";

export interface VmShimOptions {
  // no deps needed — QuickJS is accessed directly via newQuickJSWASMModuleFromVariant()
}

export interface RunInContextOptions {
  timeout?: number; // ponytail: not implemented; would need Web Worker + terminate
}

const isStaticHandle = (ctx: QuickJSContext, handle: QuickJSHandle): boolean =>
  handle === ctx.null || handle === ctx.undefined || handle === ctx.true || handle === ctx.false;

const toQuickJSHandle = (context: QuickJSContext, value: unknown): QuickJSHandle => {
  if (value === null) return context.null;
  if (value === undefined) return context.undefined;
  const t = typeof value;
  if (t === "string") return context.newString(value as string);
  if (t === "number") return context.newNumber(value as number);
  if (t === "boolean") return value ? context.true : context.false;
  if (t === "bigint") return context.newBigInt(value as bigint);
  if (t === "object") {
    const json = JSON.stringify(value);
    const result = context.evalCode(`(${json})`);
    if (result.error) {
      const errHandle = result.error;
      const message = context.getString(context.getProp(errHandle, "message"));
      errHandle.dispose();
      throw new Error(`Failed to serialize context value: ${message}`);
    }
    return result.value as QuickJSHandle;
  }
  return context.newString(String(value));
};

const extractResult = (
  context: QuickJSContext,
  result: { value?: QuickJSHandle; error?: QuickJSHandle },
): unknown => {
  if (result.error) {
    const errHandle = result.error;
    const message = context.getString(context.getProp(errHandle, "message"));
    errHandle.dispose();
    throw new Error(message);
  }
  if (!result.value) return undefined;
  const valHandle = result.value;
  const typeTag = context.typeof(valHandle);
  let out: unknown;
  if (typeTag === "string") out = context.getString(valHandle);
  else if (typeTag === "number") out = context.getNumber(valHandle);
  else if (typeTag === "boolean") out = context.dump(valHandle);
  else if (typeTag === "undefined") out = undefined;
  else out = context.dump(valHandle); // objects, arrays, etc.
  valHandle.dispose();
  return out;
};

export const createVmShim = (_options?: VmShimOptions) => {
  const runInNewContext = async (
    code: string,
    context?: Record<string, unknown>,
    _options?: RunInContextOptions,
  ): Promise<unknown> => {
    // ponytail: no pooling — fresh runtime+context per call (matches sandbox-pool pattern)
    const QuickJS = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
    const runtime = QuickJS.newRuntime();
    const ctx = runtime.newContext();

    // Set context globals if provided
    if (context) {
      for (const [key, val] of Object.entries(context)) {
        const handle = toQuickJSHandle(ctx, val);
        ctx.setProp(ctx.global, key, handle);
        if (!isStaticHandle(ctx, handle)) {
          handle.dispose();
        }
      }
    }

    const result = ctx.evalCode(code);
    const extracted = extractResult(ctx, result);

    ctx.dispose();
    runtime.dispose();

    return extracted;
  };

  const runInThisContext = (code: string, options?: RunInContextOptions): Promise<unknown> => {
    return runInNewContext(code, undefined, options);
  };

  // vm.Module and vm.Script are deferred — ponytail: would need QuickJS compilation cache
  const compileFunction = async (
    code: string,
    context?: Record<string, unknown>,
    options?: RunInContextOptions,
  ): Promise<(...args: unknown[]) => unknown> => {
    // ponytail: simple wrapper — real vm.compileFunction compiles to a function object
    return (...args: unknown[]) => {
      const globals = { ...context, args };
      return runInNewContext(`(${code}).apply(globalThis, args)`, globals, options);
    };
  };

  return { runInNewContext, runInThisContext, compileFunction };
};
