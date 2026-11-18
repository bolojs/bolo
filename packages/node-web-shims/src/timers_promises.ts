import { withCode } from "./coded-error.js";

export interface TimerHost {
  setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): unknown;
  clearTimeout(handle: any): void;
  setImmediate(callback: (...args: any[]) => void, ...args: any[]): unknown;
  clearImmediate(handle: any): void;
  setInterval(callback: (...args: any[]) => void, delay?: number, ...args: any[]): unknown;
  clearInterval(handle: any): void;
}

export interface TimerOptions {
  /**
   * An `AbortSignal` (or any EventTarget-like object exposing
   * addEventListener/removeEventListener, as Node accepts).
   */
  signal?: AbortSignal | (EventTarget & { aborted?: boolean; reason?: unknown });
  ref?: boolean;
}

const abortError = (signal: { reason?: unknown }) =>
  withCode(
    new Error("The operation was aborted", { cause: signal.reason }),
    "ABORT_ERR",
    "AbortError",
  );

// Node phrasing ("Received type string ('x')" / "Received an instance of X").
const describeReceived = (value: unknown): string => {
  if (value == null) return ` Received ${value}`;
  if (typeof value === "function") return ` Received function ${value.name}`;
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    return name ? ` Received an instance of ${name}` : " Received [Object: null prototype]";
  }
  let shown = String(typeof value === "symbol" ? value.toString() : value);
  if (typeof value === "string") shown = `'${value}'`;
  if (typeof value === "bigint") shown = `${value}n`;
  return ` Received type ${typeof value} (${shown})`;
};

// Node validates `delay` with validateNumber (ERR_INVALID_ARG_TYPE).
const validateDelay = (delay: number): void => {
  if (typeof delay !== "number" || Number.isNaN(delay))
    throw withCode(
      new TypeError('The "delay" argument must be of type number.' + describeReceived(delay)),
      "ERR_INVALID_ARG_TYPE",
    );
};

const validate = (options: TimerOptions) => {
  if (options === null || typeof options !== "object")
    throw withCode(
      new TypeError('The "options" argument must be of type object.' + describeReceived(options)),
      "ERR_INVALID_ARG_TYPE",
    );
  // Node accepts any EventTarget (e.g. internal NodeEventTarget), not just
  // AbortSignal — duck-type on addEventListener/removeEventListener. A
  // present-but-invalid signal (including null) is rejected by Node.
  const signal = options.signal as
    | (AbortSignal & { reason?: unknown; aborted?: boolean })
    | undefined;
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw withCode(
      new TypeError(
        'The "options.signal" argument must be an instance of AbortSignal.' +
          describeReceived(signal),
      ),
      "ERR_INVALID_ARG_TYPE",
    );
  if (options.ref !== undefined && typeof options.ref !== "boolean")
    throw withCode(
      new TypeError(
        `The "options.ref" argument must be of type boolean.` + describeReceived(options.ref),
      ),
      "ERR_INVALID_ARG_TYPE",
    );
};

const defaultHost: TimerHost = {
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (...args) => globalThis.setInterval(...args),
  clearInterval: (handle) => globalThis.clearInterval(handle),
  setImmediate: (callback, ...args) =>
    typeof globalThis.setImmediate === "function"
      ? globalThis.setImmediate(callback, ...args)
      : globalThis.setTimeout(callback, 0, ...args),
  clearImmediate: (handle) =>
    typeof globalThis.clearImmediate === "function"
      ? globalThis.clearImmediate(handle)
      : globalThis.clearTimeout(handle),
};

export const createTimersPromisesShim = (host: TimerHost = defaultHost) => {
  const wait = <T>(
    immediate: boolean,
    delay: number,
    value: T,
    options: TimerOptions = {},
  ): Promise<T> => {
    // Node (lib/timers/promises.js) validates inside a try/catch and returns
    // `PromiseReject(err)` — the argument errors are *rejections*, not
    // synchronous throws.
    try {
      validate(options);
    } catch (err) {
      return Promise.reject(err);
    }
    const { signal, ref = true } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const done = () => {
        cleanup();
        resolve(value);
      };
      const handle = immediate ? host.setImmediate(done) : host.setTimeout(done, delay);
      const abort = () => {
        if (immediate) host.clearImmediate(handle);
        else host.clearTimeout(handle);
        cleanup();
        reject(abortError(signal!));
      };
      if (!ref) (handle as { unref?: () => void })?.unref?.();
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const setTimeout = <T = void>(delay = 1, value?: T, options?: TimerOptions) => {
    try {
      validateDelay(delay);
    } catch (err) {
      return Promise.reject(err);
    }
    return wait(false, delay, value, options);
  };
  const setImmediate = <T = void>(value?: T, options?: TimerOptions) =>
    wait(true, 0, value, options);
  const setInterval = async function* <T = void>(delay = 1, value?: T, options: TimerOptions = {}) {
    validateDelay(delay);
    validate(options);
    const { signal, ref = true } = options;
    if (signal?.aborted) throw abortError(signal);
    // Mirrors Node's `lib/timers/promises.js` generator. Two details matter:
    // 1. A single `callback` slot is reused, and the interval callback only
    //    resolves it when it is currently parked. Resolving an already-settled
    //    promise is a no-op, so a tick that lands while the consumer awaits
    //    its own work must be *counted* (`notYielded`) rather than dropped.
    // 2. The abort check happens at the top of the outer loop only, so ticks
    //    already queued when the signal aborts are still yielded before the
    //    AbortError propagates. The vendored Node test
    //    `test-timers-interval-promisified.js` relies on this: it aborts
    //    inside iteration 2 yet asserts `totalIterations >= 3`.
    let notYielded = 0;
    let wake: (() => void) | undefined;
    const handle = host.setInterval(() => {
      notYielded++;
      if (wake) {
        wake();
        wake = undefined;
      }
    }, delay);
    if (!ref) (handle as { unref?: () => void })?.unref?.();
    const abort = () => {
      host.clearInterval(handle);
      if (wake) {
        wake();
        wake = undefined;
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!signal?.aborted) {
        if (notYielded === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        for (; notYielded > 0; notYielded--) {
          yield value;
        }
      }
      throw abortError(signal!);
    } finally {
      host.clearInterval(handle);
      signal?.removeEventListener("abort", abort);
    }
  };
  // Node's scheduler is a class instance whose constructor throws
  // ERR_ILLEGAL_CONSTRUCTOR (users cannot subclass/instantiate it).
  class Scheduler {
    constructor() {
      throw withCode(new TypeError("Illegal constructor"), "ERR_ILLEGAL_CONSTRUCTOR");
    }
  }
  const scheduler = Object.setPrototypeOf(
    {
      wait: (delay: number, options?: TimerOptions) => setTimeout(delay, undefined, options),
      yield: () => setImmediate(),
    },
    Scheduler.prototype,
  );
  return { setTimeout, setImmediate, setInterval, scheduler };
};

const timersPromises = createTimersPromisesShim();
export const { setTimeout, setImmediate, setInterval, scheduler } = timersPromises;
export default timersPromises;
