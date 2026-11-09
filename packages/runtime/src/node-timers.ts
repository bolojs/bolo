/**
 * Node-flavoured timers for a process worker: `Timeout`/`Immediate` objects
 * with `ref`/`unref`/`refresh`/`close`, `this` binding, argument validation,
 * numeric ids (`+timeout`), and the legacy `enroll`/`unenroll`/`active` API.
 * Each timer the program creates is a handle; `unref()`ed handles do not
 * count towards liveness (`hasRefed`). Built on injected native scheduling so
 * infrastructure timers never become handles.
 */

export interface NodeTimersHost {
  /** Native scheduler (the realm's real setTimeout). */
  setNative: (fn: () => void, ms: number) => unknown;
  clearNative: (id: unknown) => void;
  /** Runs after every macrotask callback (drains process.nextTick). */
  afterCallback: () => void;
  /** Defers to a later task than a plain 0ms timer (check phase). */
  hop?: (fn: () => void) => void;
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
  const live = new Set<{ refed: boolean }>();

  const hasRefed = (): boolean => {
    for (const h of live) if (h.refed) return true;
    return false;
  };

  class Timeout {
    _idleTimeout: number;
    _idleStart: number | null = null;
    _onTimeout: ((...a: unknown[]) => void) | null;
    _timerArgs: unknown[];
    _repeat: number | null;
    _destroyed = false;
    refed = true;
    private id = nextId++;
    private native: unknown;
    private pending = false;

    constructor(fn: (...a: unknown[]) => void, after: unknown, args: unknown[], repeat: boolean) {
      let ms = Number(after);
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
      live.add(this);
      this.native = host.setNative(() => this.fire(), ms);
    }

    private fire() {
      this.pending = false;
      try {
        if (typeof this._onTimeout === "function") {
          this._onTimeout.apply(this, this._timerArgs);
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
        host.afterCallback();
      }
    }

    private dispose() {
      this._destroyed = true;
      live.delete(this);
      byId.delete(this.id);
    }

    ref() {
      this.refed = true;
      return this;
    }
    unref() {
      this.refed = false;
      return this;
    }
    hasRef() {
      return this.refed;
    }
    refresh() {
      if (this._destroyed && !this.pending) {
        // Node re-arms a fired timer on refresh; a cleared one stays dead.
        if (!byId.has(this.id)) byId.set(this.id, this);
      }
      host.clearNative(this.native);
      this.schedule(this._idleTimeout);
      return this;
    }
    close() {
      host.clearNative(this.native);
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
    constructor(fn: (...a: unknown[]) => void, args: unknown[]) {
      this._onImmediate = fn;
      this._argv = args;
      live.add(this);
      host.setNative(() => {
        const run = host.hop ?? ((f: () => void) => f());
        run(() => this.fire());
      }, 0);
    }
    private fire() {
      if (this._destroyed) return;
      live.delete(this);
      // An unref'd immediate only runs while something else keeps the loop alive.
      if (!this.refed && !hasRefed()) {
        this._destroyed = true;
        return;
      }
      this._destroyed = true;
      try {
        this._onImmediate?.apply(this, this._argv);
      } finally {
        host.afterCallback();
      }
    }
    ref() {
      this.refed = true;
      return this;
    }
    unref() {
      this.refed = false;
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
      live.delete(i);
    }
  };

  // Legacy enroll/active API: items are plain objects carrying _idleTimeout/_onTimeout.
  const enrolled = new WeakMap<object, unknown>();
  const stop = (item: object) => {
    const native = enrolled.get(item);
    if (native !== undefined) {
      host.clearNative(native);
      enrolled.delete(item);
    }
  };
  const handles = new WeakMap<object, { refed: boolean }>();
  const activate = (item: Record<string, unknown>, refed: boolean) => {
    const msecs = item._idleTimeout;
    if (typeof msecs !== "number" || !(msecs >= 0)) return;
    stop(item);
    item._idleStart = Math.trunc(performance.now());
    item._idleNext = item._idleNext ?? {};
    item._idlePrev = item._idlePrev ?? {};
    const handle = handles.get(item) ?? { refed };
    handle.refed = refed;
    handles.set(item, handle);
    live.add(handle);
    enrolled.set(
      item,
      host.setNative(() => {
        enrolled.delete(item);
        live.delete(handle);
        try {
          (item._onTimeout as (() => void) | undefined)?.call(item);
        } finally {
          host.afterCallback();
        }
      }, msecs),
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
    enroll: (item, msecs) => {
      if (typeof msecs !== "number") throw invalidArgType("msecs", "number", msecs);
      if (msecs < 0 || !Number.isFinite(msecs)) {
        throw outOfRange("msecs", "a non-negative finite number", msecs);
      }
      timers.unenroll(item);
      item._idleTimeout = msecs;
    },
    unenroll: (item) => {
      if (item instanceof Timeout) {
        item.close();
        return;
      }
      if (item && typeof item === "object") {
        stop(item);
        const handle = handles.get(item);
        if (handle) live.delete(handle);
        (item as Record<string, unknown>)._idleTimeout = -1;
      }
    },
    active: (item) => activate(item, true),
    _unrefActive: (item) => activate(item, false),
  };

  return { timers, hasRefed };
};
