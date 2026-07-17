import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";

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

  async runInContext(context: VmContext, options?: RunInContextOptions): Promise<unknown> {
    if (this._disposed) throw new Error("Script has been disposed");
    if (context.disposed) throw new Error("Context has been disposed");
    const result = executeWithTimeout(
      context.context,
      context.runtime,
      this.code,
      options?.filename ?? this.filename,
      options?.timeout,
    );
    return extractResult(context.context, result);
  }

  async runInNewContext(
    context?: Record<string, unknown>,
    options?: RunInContextOptions,
  ): Promise<unknown> {
    if (this._disposed) throw new Error("Script has been disposed");
    const ctx = await createContextInternal(context);
    try {
      const result = executeWithTimeout(
        ctx.context,
        ctx.runtime,
        this.code,
        options?.filename ?? this.filename,
        options?.timeout,
      );
      return extractResult(ctx.context, result);
    } finally {
      ctx.dispose();
    }
  }

  async runInThisContext(options?: RunInContextOptions): Promise<unknown> {
    return this.runInNewContext(undefined, options);
  }
}

const createContextInternal = async (sandbox?: Record<string, unknown>): Promise<VmContext> => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();
  const sandboxRecord = sandbox ?? {};
  injectGlobals(context, sandboxRecord);
  return new VmContext(runtime, context, sandboxRecord);
};

export const createVmShim = (_options?: VmShimOptions) => {
  const runInNewContext = async (
    code: string,
    context?: Record<string, unknown>,
    options?: RunInContextOptions,
  ): Promise<unknown> => {
    const ctx = await createContextInternal(context);
    try {
      const result = executeWithTimeout(
        ctx.context,
        ctx.runtime,
        code,
        options?.filename ?? "eval.js",
        options?.timeout,
      );
      return extractResult(ctx.context, result);
    } finally {
      ctx.dispose();
    }
  };

  const runInThisContext = (code: string, options?: RunInContextOptions): Promise<unknown> => {
    return runInNewContext(code, undefined, options);
  };

  const createContext = async (
    sandbox?: Record<string, unknown>,
    _options?: CreateContextOptions,
  ): Promise<VmContext> => {
    return createContextInternal(sandbox);
  };

  const runInContext = async (
    code: string,
    context: VmContext,
    options?: RunInContextOptions,
  ): Promise<unknown> => {
    if (context.disposed) throw new Error("Context has been disposed");
    const result = executeWithTimeout(
      context.context,
      context.runtime,
      code,
      options?.filename ?? "eval.js",
      options?.timeout,
    );
    return extractResult(context.context, result);
  };

  // vm.Module and vm.compileFunction are deferred — ponytail: real vm.compileFunction compiles to a function object
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

  return {
    runInNewContext,
    runInThisContext,
    createContext,
    runInContext,
    compileFunction,
    Script,
  };
};
