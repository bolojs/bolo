import type { LoopHandle } from "./event-loop.js";
import {
  AsyncLocalStorage,
  emitInit,
  runInAsyncScope,
} from "@bolojs/node-web-shims/dist/async_hooks.js";
import { createTimersPromisesShim } from "@bolojs/node-web-shims/dist/timers_promises.js";
import { customPromisifySymbol } from "@bolojs/node-web-shims/dist/util.js";

/**
 * Node-flavoured timers for a process worker: `Timeout`/`Immediate` objects
 * with `ref`/`unref`/`refresh`/`close`, `this` binding, argument validation,
 * numeric ids (`+timeout`), and the legacy `enroll`/`unenroll`/`active` API.
 * Scheduling, ordering and liveness belong to the event loop (event-loop.ts):
 * each Timeout/Immediate owns a loop handle, and `ref`/`unref` propagate to it.
 */

export interface NodeTimersHost {
  /** One-shot timer backed by the loop (handle carries ref/unref state). */
  setTimer: (fn: () => void, ms: number) => LoopHandle;
  clearTimer: (h: LoopHandle) => void;
  setImmediate: (fn: () => void) => LoopHandle;
  clearImmediate: (h: LoopHandle) => void;
  /** Emits a process warning (e.g. TimeoutOverflowWarning). */
  warn?: (name: string, message: string) => void;
}

const TIMEOUT_MAX = 2 ** 31 - 1;

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

const invalidArgType = (name: string, expected: string, value: unknown) => {
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}.${describeReceived(value)}`,
  ) as TypeError & { code: string };
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
};

const outOfRange = (name: string, range: string, value: unknown) => {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  ) as RangeError & { code: string };
  err.code = "ERR_OUT_OF_RANGE";
  return err;
};

export interface NodeTimers {
  setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearTimeout: (t: unknown) => void;
  setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearInterval: (t: unknown) => void;
  setImmediate: (fn: (...a: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate: (i: unknown) => void;
  enroll: (item: Record<string, unknown>, msecs: unknown) => void;
  unenroll: (item: unknown) => void;
  active: (item: Record<string, unknown>) => void;
  _unrefActive: (item: Record<string, unknown>) => void;
}

export const createNodeTimers = (host: NodeTimersHost) => {
  let nextId = 1;
  const byId = new Map<number, Timeout>();

  const overflow = (ms: number) =>
    host.warn?.(
      "TimeoutOverflowWarning",
      `${ms} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
    );

  class Timeout {
    _idleTimeout: number;
    _idleStart: number | null = null;
    _onTimeout: ((...a: unknown[]) => void) | null;
    _timerArgs: unknown[];
    _repeat: number | null;
    _destroyed = false;
    refed = true;
    private id = nextId++;
    private native: LoopHandle | undefined;
    private pending = false;
    private readonly runContext = AsyncLocalStorage.snapshot();
    private readonly asyncId = emitInit("Timeout");

    constructor(fn: (...a: unknown[]) => void, after: unknown, args: unknown[], repeat: boolean) {
      let ms = Number(after);
      if (ms > TIMEOUT_MAX) overflow(ms);
      if (!(ms >= 1 && ms <= TIMEOUT_MAX)) ms = 1;
      this._idleTimeout = ms;
      this._repeat = repeat ? ms : null;
      this._onTimeout = fn;
      this._timerArgs = args;
      byId.set(this.id, this);
      this.schedule(ms);
    }

    private schedule(ms: number) {
      this.pending = true;
      this._destroyed = false;
      this._idleStart = Math.trunc(performance.now());
      const h = host.setTimer(() => this.fire(), ms);
      if (!this.refed) h.unref();
      this.native = h;
    }

    private fire() {
      this.pending = false;
      try {
        if (typeof this._onTimeout === "function") {
          this.runContext(() =>
            runInAsyncScope(this.asyncId, () =>
              Reflect.apply(this._onTimeout!, this, this._timerArgs),
            ),
          );
        }
      } finally {
        const repeat = this._repeat;
        const again =
          repeat != null &&
          !this._destroyed &&
          this._idleTimeout !== -1 &&
          typeof this._onTimeout === "function";
        if (again) {
          this.schedule(repeat);
        } else if (!this.pending) {
          this.dispose();
        }
      }
    }

    private dispose() {
      this._destroyed = true;
      byId.delete(this.id);
    }

    ref() {
      this.refed = true;
      this.native?.ref();
      return this;
    }
    unref() {
      this.refed = false;
      this.native?.unref();
      return this;
    }
    hasRef() {
      return this.refed;
    }
    refresh() {
      if (this._onTimeout === null) return this;
      if (this._destroyed && !this.pending) {
        // Node re-arms a fired timer on refresh; a cleared one stays dead.
        if (!byId.has(this.id)) byId.set(this.id, this);
      }
      if (this.native) host.clearTimer(this.native);
      this.schedule(this._idleTimeout);
      return this;
    }
    close() {
      this._onTimeout = null;
      if (this.native) host.clearTimer(this.native);
      this.pending = false;
      this.dispose();
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
    [Symbol.dispose]() {
      this.close();
    }
  }

  class Immediate {
    _onImmediate: ((...a: unknown[]) => void) | null;
    _argv: unknown[];
    _destroyed = false;
    refed = true;
    native: LoopHandle;
    private readonly runContext = AsyncLocalStorage.snapshot();
    private readonly asyncId = emitInit("Immediate");
    constructor(fn: (...a: unknown[]) => void, args: unknown[]) {
      this._onImmediate = fn;
      this._argv = args;
      this.native = host.setImmediate(() => this.fire());
    }
    private fire() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.refed = false;
      try {
        if (this._onImmediate) {
          this.runContext(() =>
            runInAsyncScope(this.asyncId, () =>
              Reflect.apply(this._onImmediate!, this, this._argv),
            ),
          );
        }
      } finally {
        this._onImmediate = null;
      }
    }
    ref() {
      this.refed = true;
      this.native.ref();
      return this;
    }
    unref() {
      this.refed = false;
      this.native.unref();
      return this;
    }
    hasRef() {
      return this.refed;
    }
    [Symbol.dispose]() {
      clearImmediate(this);
    }
  }

  const requireFn = (fn: unknown) => {
    if (typeof fn !== "function") throw invalidArgType("callback", "function", fn);
  };

  const clearTimer = (t: unknown) => {
    if (t instanceof Timeout) t.close();
    else if (typeof t === "number" || typeof t === "string") byId.get(Number(t))?.close();
  };
  const clearImmediate = (i: unknown) => {
    if (i instanceof Immediate && !i._destroyed) {
      i._destroyed = true;
      host.clearImmediate(i.native);
    }
  };

  // Legacy enroll/active API: items are plain objects carrying _idleTimeout/_onTimeout.
  const enrolled = new WeakMap<object, LoopHandle>();
  const stop = (item: object) => {
    const native = enrolled.get(item);
    if (native) {
      host.clearTimer(native);
      enrolled.delete(item);
    }
  };
  const activate = (item: Record<string, unknown>, refed: boolean) => {
    const msecs = item._idleTimeout;
    if (typeof msecs !== "number" || !(msecs >= 0)) return;
    stop(item);
    item._idleStart = Math.trunc(performance.now());
    item._idleNext = item._idleNext ?? {};
    item._idlePrev = item._idlePrev ?? {};
    const native = host.setTimer(() => {
      enrolled.delete(item);
      (item._onTimeout as (() => void) | undefined)?.call(item);
    }, msecs);
    if (!refed) native.unref();
    enrolled.set(item, native);
  };

  const deprecated = new Set<string>();
  const deprecate = (name: string) => {
    if (deprecated.has(name)) return;
    deprecated.add(name);
    host.warn?.(
      "DeprecationWarning",
      `timers.${name}() is deprecated. Please use setTimeout instead.`,
    );
  };

  const timers: NodeTimers = {
    setTimeout: (fn, ms, ...args) => {
      requireFn(fn);
      return new Timeout(fn, ms, args, false);
    },
    clearTimeout: clearTimer,
    setInterval: (fn, ms, ...args) => {
      requireFn(fn);
      return new Timeout(fn, ms, args, true);
    },
    clearInterval: clearTimer,
    setImmediate: (fn, ...args) => {
      requireFn(fn);
      return new Immediate(fn, args);
    },
    clearImmediate,
    enroll: (item, msecs: unknown) => {
      deprecate("enroll");
      if (typeof msecs !== "number") throw invalidArgType("msecs", "number", msecs);
      if (msecs < 0 || !Number.isFinite(msecs)) {
        throw outOfRange("msecs", "a non-negative finite number", msecs);
      }
      timers.unenroll(item);
      if (msecs > TIMEOUT_MAX) {
        overflow(msecs);
        msecs = 1;
      }
      item._idleTimeout = msecs;
    },
    unenroll: (item) => {
      deprecate("unenroll");
      if (item instanceof Timeout) {
        item.close();
        return;
      }
      if (item && typeof item === "object") {
        stop(item);
        (item as Record<string, unknown>)._idleTimeout = -1;
      }
    },
    active: (item) => {
      deprecate("active");
      activate(item, true);
    },
    _unrefActive: (item) => activate(item, false),
  };

  const promises = createTimersPromisesShim(timers);
  for (const name of ["setTimeout", "setImmediate", "setInterval"] as const) {
    Object.defineProperty(timers[name], Symbol.for("nodejs.util.promisify.custom"), {
      value: promises[name],
    });
    // unenv's promisify() reads a *different* symbol than Node's — mirror the
    // custom promisify onto it so `promisify(timers.setImmediate) ===
    // timers/promises.setImmediate` (bundled code uses unenv util).
    (timers[name] as unknown as Record<PropertyKey, unknown>)[customPromisifySymbol] =
      promises[name];
  }
  return { timers, promises };
};
