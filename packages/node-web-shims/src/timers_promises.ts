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
  Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });

const validate = (options: TimerOptions) => {
  if (options === null || typeof options !== "object")
    throw Object.assign(new TypeError('The "options" argument must be of type object'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  // Node accepts any EventTarget (e.g. internal NodeEventTarget), not just
  // AbortSignal — duck-type on addEventListener/removeEventListener.
  const signal = options.signal as
    | (AbortSignal & { reason?: unknown; aborted?: boolean })
    | undefined;
  if (
    signal !== undefined &&
    signal !== null &&
    typeof signal !== "object" &&
    typeof signal !== "function"
  )
    throw Object.assign(
      new TypeError('The "options.signal" argument must be an instance of AbortSignal'),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  if (
    signal != null &&
    (typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw Object.assign(
      new TypeError('The "options.signal" argument must be an instance of AbortSignal'),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  if (options.ref !== undefined && typeof options.ref !== "boolean")
    throw Object.assign(new TypeError('The "options.ref" argument must be of type boolean'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
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
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      validate(options);
      const { signal, ref = true } = options;
      if (signal?.aborted) return reject(abortError(signal));
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
  const setTimeout = <T = void>(delay = 1, value?: T, options?: TimerOptions) =>
    wait(false, delay, value, options);
  const setImmediate = <T = void>(value?: T, options?: TimerOptions) =>
    wait(true, 0, value, options);
  const setInterval = async function* <T = void>(delay = 1, value?: T, options: TimerOptions = {}) {
    validate(options);
    const { signal, ref = true } = options;
    if (signal?.aborted) throw abortError(signal);
    let pending = 0;
    let wake: (() => void) | undefined;
    const handle = host.setInterval(() => {
      pending++;
      wake?.();
    }, delay);
    if (!ref) (handle as { unref?: () => void })?.unref?.();
    const abort = () => {
      host.clearInterval(handle);
      wake?.();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        if (!pending && !signal?.aborted)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (signal?.aborted) throw abortError(signal);
        while (pending > 0) {
          pending--;
          yield value;
          if (signal?.aborted) throw abortError(signal);
        }
      }
    } finally {
      host.clearInterval(handle);
      signal?.removeEventListener("abort", abort);
    }
  };
  const scheduler = {
    wait: (delay: number, options?: TimerOptions) => setTimeout(delay, undefined, options),
    yield: () => setImmediate(),
  };
  return { setTimeout, setImmediate, setInterval, scheduler };
};

const timersPromises = createTimersPromisesShim();
export const { setTimeout, setImmediate, setInterval, scheduler } = timersPromises;
export default timersPromises;
