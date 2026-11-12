import asyncHooks from "unenv/node/async_hooks";
import {
  AsyncResource as UnenvAsyncResource,
  createHook as unenvCreateHook,
} from "unenv/node/async_hooks";
import type nodeAsyncHooks from "node:async_hooks";
export * from "unenv/node/async_hooks";

let context = new Map<AsyncLocalStorage<unknown>, unknown>();

export class AsyncLocalStorage<T> {
  private enabled = true;
  readonly name: string;
  private readonly defaultValue: T | undefined;

  constructor(options?: { defaultValue?: T; name?: string }) {
    this.name = options?.name ?? "";
    this.defaultValue = options?.defaultValue;
  }

  disable() {
    this.enabled = false;
    context.delete(this);
  }

  getStore(): T | undefined {
    return this.enabled && context.has(this) ? (context.get(this) as T) : this.defaultValue;
  }

  enterWith(store: T) {
    this.enabled = true;
    context = new Map(context).set(this, store);
  }

  run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
    const previous = context;
    this.enterWith(store);
    try {
      return callback(...args);
    } finally {
      context = previous;
    }
  }

  exit<R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R {
    const previous = context;
    context = new Map(context);
    context.delete(this);
    try {
      return callback(...args);
    } finally {
      context = previous;
    }
  }

  static snapshot() {
    const captured = new Map(context);
    return <R, A extends unknown[]>(callback: (...args: A) => R, ...args: A): R => {
      const previous = context;
      context = new Map([...captured].filter(([storage]) => storage.enabled));
      try {
        return callback(...args);
      } finally {
        context = previous;
      }
    };
  }

  static bind<F extends (...args: any[]) => any>(fn: F): F {
    const run = this.snapshot();
    return function (this: unknown, ...args: Parameters<F>) {
      return run(() => Reflect.apply(fn, this, args));
    } as F;
  }
}

export class AsyncResource extends UnenvAsyncResource {
  private readonly runContext = AsyncLocalStorage.snapshot();

  override runInAsyncScope<F extends (...args: any[]) => any>(
    fn: F,
    thisArg?: unknown,
    ...args: Parameters<F>
  ): ReturnType<F> {
    return this.runContext(() => Reflect.apply(fn, thisArg, args));
  }
}

export const createHook: typeof nodeAsyncHooks.createHook = (callbacks) => {
  for (const name of ["init", "before", "after", "destroy", "promiseResolve"] as const) {
    if (callbacks[name] !== undefined && typeof callbacks[name] !== "function") {
      throw Object.assign(new TypeError(`hook.${name} must be a function`), {
        code: "ERR_ASYNC_CALLBACK",
      });
    }
  }
  return unenvCreateHook(callbacks);
};

export const createAsyncHooksShim = (): typeof asyncHooks => {
  return { ...asyncHooks, AsyncLocalStorage, AsyncResource, createHook };
};

export default createAsyncHooksShim();
