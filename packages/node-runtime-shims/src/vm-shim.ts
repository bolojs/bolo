import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import { unsupportedError } from "@bolojs/node-web-shims";

// ponytail: separate QuickJS heap per context; no shared prototypes across the boundary.
// JSON-round-trippable values only. vm.Module/SourceTextModule deferred post-v1.

export interface VmShimOptions {
  // no deps needed — QuickJS is accessed directly via newQuickJSWASMModuleFromVariant()
}

export interface RunInContextOptions {
  filename?: string;
  timeout?: number;
}

export interface CreateContextOptions {
  // no options implemented yet
}

export class VmContext {
  readonly runtime: QuickJSRuntime;
  readonly context: QuickJSContext;
  readonly sandbox: Record<string, unknown>;
  private _disposed = false;

  constructor(runtime: QuickJSRuntime, context: QuickJSContext, sandbox: Record<string, unknown>) {
    this.runtime = runtime;
    this.context = context;
    this.sandbox = sandbox;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    if (!this._disposed) {
      this._disposed = true;
      this.context.dispose();
      this.runtime.dispose();
    }
  }
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

const injectGlobals = (context: QuickJSContext, globals?: Record<string, unknown>): void => {
  if (!globals) return;
  for (const [key, val] of Object.entries(globals)) {
    const handle = toQuickJSHandle(context, val);
    context.setProp(context.global, key, handle);
    if (!isStaticHandle(context, handle)) {
      handle.dispose();
    }
  }
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

const executeWithTimeout = (
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  code: string,
  filename: string,
  timeout?: number,
): { value?: QuickJSHandle; error?: QuickJSHandle } => {
  if (timeout !== undefined && timeout > 0) {
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeout));
  }
  try {
    return context.evalCode(code, filename);
  } finally {
    if (timeout !== undefined && timeout > 0) {
      runtime.removeInterruptHandler();
    }
  }
};

let quickJSModule: any = undefined;
const quickJSPromise = newQuickJSWASMModuleFromVariant(releaseSyncVariant)
  .then((mod) => {
    quickJSModule = mod;
    return mod;
  })
  .catch(() => undefined);

export const initQuickJS = async (): Promise<void> => {
  if (!quickJSModule) {
    quickJSModule = await quickJSPromise;
  }
};

const IS_CONTEXT = Symbol("IS_CONTEXT");

const evalInProxySync = (code: string, sandbox?: Record<string, unknown>): unknown => {
  const scope = sandbox ?? {};
  const proxy = new Proxy(scope, {
    has(_target, key) {
      if (key === Symbol.unscopables) return false;
      return true;
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return (target as any)[key];
      if (key in globalThis) return (globalThis as any)[key];
      return undefined;
    },
    set(target, key, val) {
      (target as any)[key] = val;
      return true;
    },
  });
  const fn = new Function(
    "sandbox",
    "with(sandbox) { return eval(" + JSON.stringify(code) + "); }",
  );
  return fn(proxy);
};

export class Script {
  private readonly code: string;
  private readonly filename: string;
  private _disposed = false;

  constructor(code: string, options?: { filename?: string }) {
    this.code = code;
    this.filename = options?.filename ?? "script.js";
  }

  get disposed(): boolean {
    return this._disposed;
  }

  dispose(): void {
    this._disposed = true;
  }

  runInContext(context: VmContext, options?: RunInContextOptions): unknown {
    if (this._disposed) throw new Error("Script has been disposed");
    return runInContextInternal(this.code, context, { ...options, filename: this.filename });
  }

  runInNewContext(context?: Record<string, unknown>, options?: RunInContextOptions): unknown {
    if (this._disposed) throw new Error("Script has been disposed");
    return runInNewContextInternal(this.code, context, { ...options, filename: this.filename });
  }

  runInThisContext(options?: RunInContextOptions): unknown {
    return this.runInNewContext(undefined, options);
  }
}

const createContextInternal = (sandbox?: Record<string, unknown>): VmContext => {
  const sandboxRecord = sandbox ?? {};
  if (quickJSModule) {
    const runtime = quickJSModule.newRuntime();
    const context = runtime.newContext();
    injectGlobals(context, sandboxRecord);
    const vmCtx = new VmContext(runtime, context, sandboxRecord);
    Object.assign(vmCtx, sandboxRecord);
    (vmCtx as unknown as Record<symbol, boolean>)[IS_CONTEXT] = true;
    return vmCtx;
  }
  const vmCtx = new VmContext(null as any, null as any, sandboxRecord);
  Object.assign(vmCtx, sandboxRecord);
  (vmCtx as unknown as Record<symbol, boolean>)[IS_CONTEXT] = true;
  return vmCtx;
};

const runInNewContextInternal = (
  code: string,
  context?: Record<string, unknown>,
  options?: RunInContextOptions,
): unknown => {
  if (options?.timeout !== undefined && options.timeout > 0 && !quickJSModule) {
    throw unsupportedError("VM_BACKEND", "vm timeout requires initialized QuickJS module");
  }
  if (quickJSModule) {
    const ctx = createContextInternal(context);
    try {
      const result = executeWithTimeout(
        ctx.context,
        ctx.runtime,
        code,
        options?.filename ?? "eval.js",
        options?.timeout,
      );
      const out = extractResult(ctx.context, result);
      if (context) {
        Object.assign(context, ctx.sandbox);
      }
      return out;
    } finally {
      ctx.dispose();
    }
  }
  return evalInProxySync(code, context);
};

const runInContextInternal = (
  code: string,
  context: VmContext | Record<string, unknown>,
  options?: RunInContextOptions,
): unknown => {
  if (context instanceof VmContext) {
    if (context.disposed) throw new Error("Context has been disposed");
    if (context.context && context.runtime) {
      const result = executeWithTimeout(
        context.context,
        context.runtime,
        code,
        options?.filename ?? "eval.js",
        options?.timeout,
      );
      const out = extractResult(context.context, result);
      Object.assign(context, context.sandbox);
      return out;
    }
    return evalInProxySync(code, context.sandbox);
  }
  return evalInProxySync(code, context);
};

export const createVmShim = (_options?: VmShimOptions) => {
  const runInNewContext = (
    code: string,
    context?: Record<string, unknown>,
    options?: RunInContextOptions,
  ): unknown => {
    return runInNewContextInternal(code, context, options);
  };

  const runInThisContext = (code: string, options?: RunInContextOptions): unknown => {
    return runInNewContext(code, undefined, options);
  };

  const createContext = (
    sandbox?: Record<string, unknown>,
    _options?: CreateContextOptions,
  ): VmContext => {
    return createContextInternal(sandbox);
  };

  const isContext = (sandbox: unknown): boolean => {
    return (
      sandbox instanceof VmContext ||
      Boolean(sandbox && (sandbox as unknown as Record<symbol, boolean>)[IS_CONTEXT])
    );
  };

  const runInContext = (
    code: string,
    context: VmContext,
    options?: RunInContextOptions,
  ): unknown => {
    return runInContextInternal(code, context, options);
  };

  // vm.Module and vm.compileFunction are deferred — ponytail: real vm.compileFunction compiles to a function object
  const compileFunction = (
    code: string,
    context?: Record<string, unknown>,
    options?: RunInContextOptions,
  ): ((...args: unknown[]) => unknown) => {
    // ponytail: simple wrapper — real vm.compileFunction compiles to a function object
    return (...args: unknown[]) => {
      const globals = { ...context, args };
      return runInNewContext(`(${code}).apply(globalThis, args)`, globals, options);
    };
  };

  return {
    runInNewContext,
    runInThisContext,
    createContext,
    isContext,
    runInContext,
    compileFunction,
    Script,
  };
};
