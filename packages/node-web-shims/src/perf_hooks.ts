import perf_hooks from "unenv/node/perf_hooks";

export * from "unenv/node/perf_hooks";

// ---------------------------------------------------------------------------
// PerformanceObserver — backed by the Web PerformanceObserver. unenv ships a
// stub whose observe()/disconnect() throw not-implemented; Node core tests
// (test-performanceobserver) exercise real delivery of mark/measure entries,
// so wrap the platform observer and translate the entry-list surface.
// ---------------------------------------------------------------------------

interface NativeObserverInstance {
  observe(options: { entryTypes?: string[]; type?: string; buffered?: boolean }): void;
  disconnect(): void;
  takeRecords(): PerformanceEntryList;
}

const NativePerformanceObserver = (globalThis as { PerformanceObserver?: unknown })
  .PerformanceObserver as
  | ((new (
      callback: (list: { getEntries(): PerformanceEntry[] }, observer: unknown) => void,
    ) => NativeObserverInstance) & {
      supportedEntryTypes?: string[];
    })
  | undefined;

const codedError = (code: string, name: string, message: string): Error =>
  Object.assign(new Error(message), { code, name });

/**
 * Node's `invalidArgType` phrasing — "The "x" argument must be of type
 * object. Received type number (1)". Mirrors lib/internal/errors.js so the
 * message text matches what Node's own tests assert on.
 */
const describeReceived = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return name ? `an instance of ${name}` : "an instance of Object";
  }
  if (typeof value === "string") return `type string ('${value}')`;
  return `type ${typeof value} (${String(value)})`;
};

const argTypeError = (argName: string, expected: string, value: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${argName}" argument must be of type ${expected}. Received ${describeReceived(value)}`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

/** Node throws ERR_MISSING_ARGS when neither entryTypes nor type is given. */
const missingArgsError = (): TypeError =>
  Object.assign(
    new TypeError('The "options.entryTypes" and "options.type" arguments must be specified'),
    { code: "ERR_MISSING_ARGS" },
  );

/** Node throws ERR_INVALID_ARG_VALUE when both entryTypes and type are given. */
const invalidArgValueError = (message: string): TypeError =>
  Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_VALUE" });

/**
 * Node-shaped view over a batch of performance entries. The platform
 * PerformanceEntryList already exposes getEntries/getEntriesByName/
 * getEntriesByType; this adds the Node class identity and a stable array.
 */
export class PerformanceObserverEntryList {
  private readonly _entries: readonly PerformanceEntry[];

  constructor(entries: readonly PerformanceEntry[]) {
    this._entries = entries;
  }

  getEntries(): PerformanceEntry[] {
    return [...this._entries];
  }

  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    return this._entries.filter(
      (e) => e.name === name && (type === undefined || e.entryType === type),
    );
  }

  getEntriesByType(type: string): PerformanceEntry[] {
    return this._entries.filter((e) => e.entryType === type);
  }
}

const toEntryList = (nativeList: {
  getEntries(): PerformanceEntry[];
}): PerformanceObserverEntryList => new PerformanceObserverEntryList(nativeList.getEntries());

/**
 * Entry types the platform PerformanceObserver can actually deliver. The
 * browser only knows 'mark', 'measure' and 'resource'; Node's native-only
 * types ('gc', 'http', 'http2', 'net', 'dns', 'function') have no platform
 * counterpart, so they are observed by Node's own bookkeeping only.
 */
const NATIVE_OBSERVED_TYPES: ReadonlySet<string> = new Set(["mark", "measure", "resource"]);

/** The realm's buffered entries of one type — Node's `buffered: true` source. */
const filterBufferByType = (type: string): PerformanceEntry[] => {
  const perf = globalThis as {
    performance?: { getEntriesByType?: (t: string) => PerformanceEntry[] };
  };
  return perf?.performance?.getEntriesByType?.(type) ?? [];
};

type ObserverCallback = (list: PerformanceObserverEntryList, observer: unknown) => void;

/**
 * Node's `kSupportedEntryTypes` (lib/perf/observe.js). Node silently ignores
 * entry types it does not know — `observe({entryTypes: ['mark', 'node']})` is
 * valid and simply observes 'mark'.
 */
const SUPPORTED_ENTRY_TYPES: readonly string[] = Object.freeze([
  "dns",
  "function",
  "gc",
  "http",
  "http2",
  "mark",
  "measure",
  "net",
  "resource",
]);

/**
 * Observer-type indices into Node's `observerCounts` array
 * (internalBinding('performance').observerCounts). Node maps the entry
 * types it tracks natively onto a fixed index; 'mark'/'measure'/'resource'
 * are not tracked by the native counters.
 */
const OBSERVER_TYPE_GC = 0;
const OBSERVER_TYPE_HTTP = 1;
const OBSERVER_TYPE_HTTP2 = 2;
const OBSERVER_TYPE_NET = 3;
const OBSERVER_TYPE_DNS = 4;
const OBSERVER_TYPE_COUNT = 6;

const observerTypeFor = (type: string): number | undefined => {
  switch (type) {
    case "gc":
      return OBSERVER_TYPE_GC;
    case "http":
      return OBSERVER_TYPE_HTTP;
    case "http2":
      return OBSERVER_TYPE_HTTP2;
    case "net":
      return OBSERVER_TYPE_NET;
    case "dns":
      return OBSERVER_TYPE_DNS;
    default:
      return undefined;
  }
};

/**
 * Live view of Node's `internalBinding('performance').observerCounts` — a
 * Uint32Array counting the active observers per native observer type. The
 * perf_hooks shim owns the count because it is the only place that knows
 * which observers are live.
 */
const observerCounts = new Uint32Array(OBSERVER_TYPE_COUNT);

export class PerformanceObserver {
  static supportedEntryTypes: readonly string[] = SUPPORTED_ENTRY_TYPES;

  private readonly _callback: ObserverCallback;
  private _native: NativeObserverInstance | undefined;
  /** Entry types this observer watches (Node keeps them in a Set). */
  private readonly _entryTypes = new Set<string>();
  /** Entries buffered since the last dispatch (Node's `#buffer`). */
  private _buffer: PerformanceEntry[] = [];
  /** Node's observer mode: undefined | 'multiple' | 'single'. */
  private _mode: "multiple" | "single" | undefined;

  constructor(callback: ObserverCallback) {
    if (typeof callback !== "function") {
      throw argTypeError("callback", "function", callback);
    }
    this._callback = callback;
  }

  observe(options?: { entryTypes?: unknown; type?: unknown; buffered?: unknown }): void {
    if (options === undefined || options === null || typeof options !== "object") {
      throw argTypeError("options", "object", options);
    }
    const entryTypes = options.entryTypes;
    const type = options.type;
    const buffered = options.buffered === true;

    if (entryTypes === undefined && type === undefined) {
      throw missingArgsError();
    }
    if (entryTypes !== undefined && type !== undefined) {
      throw invalidArgValueError(
        'The "options.entryTypes" property cannot be used with "options.type"',
      );
    }

    // Node refuses to switch an observer between the multi-type and
    // single-type modes.
    if (this._mode === "single" && entryTypes !== undefined) {
      throw codedError(
        "ERR_INVALID_STATE",
        "Error",
        "PerformanceObserver can not change to multiple observations",
      );
    }
    if (this._mode === "multiple" && type !== undefined) {
      throw codedError(
        "ERR_INVALID_STATE",
        "Error",
        "PerformanceObserver can not change to single observation",
      );
    }

    if (entryTypes !== undefined) {
      if (!Array.isArray(entryTypes)) {
        throw argTypeError("options.entryTypes", "string[]", entryTypes);
      }
      this._mode = "multiple";
      this._decrementCounts();
      this._entryTypes.clear();
      for (const t of entryTypes) {
        if (typeof t === "string" && SUPPORTED_ENTRY_TYPES.includes(t)) {
          this._entryTypes.add(t);
          this._incrementCount(t);
        }
      }
    } else {
      if (typeof type !== "string") {
        throw argTypeError("options.type", "string", type);
      }
      this._mode = "single";
      // Node ignores a type it does not support instead of throwing.
      if (!SUPPORTED_ENTRY_TYPES.includes(type)) return;
      this._entryTypes.add(type);
      this._incrementCount(type);
      if (buffered) {
        const bufferedEntries = filterBufferByType(type);
        this._buffer.push(...bufferedEntries);
        this._dispatchPending();
      }
    }

    if (this._entryTypes.size === 0) {
      this.disconnect();
      return;
    }

    if (NativePerformanceObserver === undefined) {
      // No platform observer (non-DOM realm): records still land in
      // performance's entry buffer, takeRecords drains them lazily.
      return;
    }
    // The platform observer rejects unknown entry types, so it only ever
    // sees the subset Node actually watches.
    const nativeTypes = [...this._entryTypes].filter((t) => NATIVE_OBSERVED_TYPES.has(t));
    if (nativeTypes.length === 0) return;
    this._native = new NativePerformanceObserver((list) => {
      this._onNativeEntries(list.getEntries());
    });
    this._native.observe({ entryTypes: nativeTypes });
  }

  disconnect(): void {
    this._decrementCounts();
    this._native?.disconnect();
    this._native = undefined;
    this._buffer = [];
    this._entryTypes.clear();
    this._mode = undefined;
  }

  takeRecords(): PerformanceEntry[] {
    const records = this._buffer;
    this._buffer = [];
    return records;
  }

  /** Node's per-observer `pending` flag — true while entries await dispatch. */
  get pending(): boolean {
    return this._buffer.length > 0;
  }

  private _incrementCount(type: string): void {
    const index = observerTypeFor(type);
    if (index !== undefined) observerCounts[index]++;
  }

  private _decrementCounts(): void {
    for (const type of this._entryTypes) {
      const index = observerTypeFor(type);
      if (index !== undefined && observerCounts[index] > 0) observerCounts[index]--;
    }
  }

  /**
   * The platform observer delivers one batch per notification; Node buffers
   * every entry until its next tick and then dispatches the whole buffer in
   * one callback. Mirror that so a burst of `performance.mark()` calls
   * arrives as a single callback with all entries.
   */
  private _onNativeEntries(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      if (!this._entryTypes.has(entry.entryType)) continue;
      this._buffer.push(entry);
    }
    this._dispatchPending();
  }

  private _dispatchPending(): void {
    if (this._buffer.length === 0) return;
    if (this._dispatchScheduled) return;
    this._dispatchScheduled = true;
    queueMicrotask(() => {
      this._dispatchScheduled = false;
      const entries = this._buffer;
      this._buffer = [];
      if (entries.length === 0) return;
      this._callback(new PerformanceObserverEntryList(entries), this);
    });
  }

  private _dispatchScheduled = false;

  // Async-context stubs matching unenv's PerformanceObserver surface.
  bind<T extends (...args: never[]) => unknown>(fn: T): T {
    return fn;
  }
  runInAsyncScope<T>(fn: (...args: unknown[]) => T, thisArg?: unknown, ...args: unknown[]): T {
    return fn.call(thisArg, ...args);
  }
  asyncId(): number {
    return 0;
  }
  triggerAsyncId(): number {
    return 0;
  }
  emitDestroy(): this {
    return this;
  }
}

/**
 * `observerCounts` — the live Uint32Array Node's
 * `internalBinding('performance')` exposes. Node counts the live observers
 * per native observer type ('gc', 'http', 'http2', 'net', 'dns'); the
 * platform-only types ('mark', 'measure', 'resource') are not counted.
 *
 * Exposed under both names: `observerCounts` is the binding's name, and
 * `performanceObserverCounts` is kept for the existing internal/test/binding
 * shim, which reads it through `__browserContainers.shims.perf_hooks`.
 */
export { observerCounts };

/**
 * Creates a node:perf_hooks shim — unenv's entries/histograms/constants plus
 * a working PerformanceObserver over the platform observer.
 */
export const createPerfHooksShim = (): typeof perf_hooks & {
  PerformanceObserver: typeof PerformanceObserver;
  PerformanceObserverEntryList: typeof PerformanceObserverEntryList;
  observerCounts: Uint32Array;
} => {
  const base = perf_hooks as unknown as Record<string, unknown>;
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    PerformanceObserver,
    PerformanceObserverEntryList,
    observerCounts,
    performanceObserverCounts: observerCounts,
  }) as typeof perf_hooks & {
    PerformanceObserver: typeof PerformanceObserver;
    PerformanceObserverEntryList: typeof PerformanceObserverEntryList;
    observerCounts: Uint32Array;
  };
};

export default createPerfHooksShim();
