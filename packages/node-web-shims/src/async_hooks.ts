import asyncHooks from "unenv/node/async_hooks";
import {
  AsyncResource as UnenvAsyncResource,
  createHook as unenvCreateHook,
} from "unenv/node/async_hooks";
import type nodeAsyncHooks from "node:async_hooks";
export * from "unenv/node/async_hooks";

/**
 * `AsyncLocalStorage` — context propagation across async boundaries.
 *
 * The browser has no async_hooks, so the store is kept in a module-level map
 * that async callbacks capture (via `snapshot()`) when they are scheduled and
 * restore when they run. `run`/`enterWith`/`exit` follow Node's semantics:
 * `run` restores the previous context when the callback returns (even when it
 * throws), `enterWith` keeps the store for the rest of the current turn, and
 * `exit` removes it.
 */
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

// ── Async hooks runtime ────────────────────────────────────────────
//
// unenv's `createHook` is a no-op: the callbacks never fire. This is a
// minimal but real implementation — enough for `init`/`before`/`after`/
// `destroy`/`promiseResolve` around the async boundaries the runtime owns
// (promises, timers, immediates and nextTick callbacks).

type HookCallbacks = {
  init?: (asyncId: number, type: string, triggerAsyncId: number, resource: object) => void;
  before?: (asyncId: number) => void;
  after?: (asyncId: number) => void;
  destroy?: (asyncId: number) => void;
  promiseResolve?: (asyncId: number) => void;
};

interface HookEntry {
  callbacks: HookCallbacks;
  enabled: boolean;
}

const hooks = new Set<HookEntry>();
let nextAsyncId = 1;
let currentAsyncId = 0;

/** Runs `fn` inside the given async scope, firing before/after around it. */
export const runInAsyncScope = <T>(asyncId: number, fn: () => T): T => {
  const previous = currentAsyncId;
  currentAsyncId = asyncId;
  for (const hook of hooks) {
    if (hook.enabled) hook.callbacks.before?.(asyncId);
  }
  try {
    return fn();
  } finally {
    for (const hook of hooks) {
      if (hook.enabled) hook.callbacks.after?.(asyncId);
    }
    currentAsyncId = previous;
  }
};

/** Announces a new async resource; returns its id. */
export const emitInit = (type: string, resource: object = {}): number => {
  const asyncId = nextAsyncId++;
  for (const hook of hooks) {
    if (hook.enabled) hook.callbacks.init?.(asyncId, type, currentAsyncId, resource);
  }
  return asyncId;
};

/**
 * Reserves an async id without announcing a resource — for boundaries Node
 * does not report through 'init' (e.g. `process.nextTick`).
 */
export const reserveAsyncId = (): number => nextAsyncId++;

/** Announces that an async resource is gone. */
export const emitDestroy = (asyncId: number): void => {
  for (const hook of hooks) {
    if (hook.enabled) hook.callbacks.destroy?.(asyncId);
  }
};

/** Announces that a promise settled. */
export const emitPromiseResolve = (asyncId: number): void => {
  for (const hook of hooks) {
    if (hook.enabled) hook.callbacks.promiseResolve?.(asyncId);
  }
};

/**
 * Wraps `fn` so it runs inside a fresh async scope: `init` fires when the
 * callback is scheduled, `before`/`after` when it runs, `destroy` once it has
 * run.
 */
export const bindAsyncCallback = <T extends (...args: any[]) => any>(fn: T, type: string): T => {
  const asyncId = emitInit(type);
  return function (this: unknown, ...args: Parameters<T>) {
    try {
      return runInAsyncScope(asyncId, () => Reflect.apply(fn, this, args)) as ReturnType<T>;
    } finally {
      emitDestroy(asyncId);
    }
  } as T;
};

class ShimAsyncHook {
  readonly __unenv__ = true;
  private readonly entry: HookEntry;

  constructor(callbacks: HookCallbacks = {}) {
    this.entry = { callbacks, enabled: false };
    hooks.add(this.entry);
  }

  enable(): this {
    this.entry.enabled = true;
    return this;
  }

  disable(): this {
    this.entry.enabled = false;
    return this;
  }
}

/**
 * Instruments `Promise.prototype.then` so promise continuations announce an
 * async resource ('init'), run inside their own scope ('before'/'after') and
 * report their settlement ('promiseResolve').
 *
 * Only install it in a realm that owns its globals (a process worker): the
 * patch is global by nature.
 */
export const instrumentPromises = (): void => {
  const proto = Promise.prototype as Promise<unknown> & {
    then: Promise<unknown>["then"];
  };
  if ((proto.then as { __boloInstrumented?: boolean }).__boloInstrumented) return;
  const originalThen = proto.then;
  const patched = function then<T, R>(
    this: Promise<T>,
    onFulfilled?: ((value: T) => R | PromiseLike<R>) | null,
    onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
  ): Promise<R> {
    const asyncId = emitInit("PROMISE");
    const wrap = (handler: ((value: never) => unknown) | null | undefined) => {
      if (typeof handler !== "function") return handler;
      return (value: never) =>
        runInAsyncScope(asyncId, () => {
          try {
            return handler(value);
          } finally {
            emitPromiseResolve(asyncId);
          }
        });
    };
    return originalThen.call(
      this,
      wrap(onFulfilled as ((value: never) => unknown) | null | undefined) as never,
      wrap(onRejected as ((value: never) => unknown) | null | undefined) as never,
    ) as Promise<R>;
  };
  (patched as { __boloInstrumented?: boolean }).__boloInstrumented = true;
  proto.then = patched as Promise<unknown>["then"];
};

export const createHook: typeof nodeAsyncHooks.createHook = (callbacks) => {
  for (const name of ["init", "before", "after", "destroy", "promiseResolve"] as const) {
    if (callbacks[name] !== undefined && typeof callbacks[name] !== "function") {
      throw Object.assign(new TypeError(`hook.${name} must be a function`), {
        code: "ERR_ASYNC_CALLBACK",
      });
    }
  }
  return new ShimAsyncHook(callbacks) as unknown as ReturnType<typeof unenvCreateHook>;
};

export const createAsyncHooksShim = (): typeof asyncHooks => {
  return { ...asyncHooks, AsyncLocalStorage, AsyncResource, createHook };
};

export default createAsyncHooksShim();
