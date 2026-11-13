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

const argTypeError = (argName: string, expected: string, value: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${argName}" argument must be of type ${expected}. Received ${
        value === null
          ? "null"
          : typeof value === "object"
            ? `an instance of ${(value as { constructor?: { name?: string } }).constructor?.name ?? "Object"}`
            : `type ${typeof value} (${String(value)})`
      }`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

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

type ObserverCallback = (list: PerformanceObserverEntryList, observer: unknown) => void;

export class PerformanceObserver {
  static supportedEntryTypes: readonly string[] = Object.freeze([
    ...new Set([
      ...(NativePerformanceObserver?.supportedEntryTypes ?? ["mark", "measure"]),
      "mark",
      "measure",
    ]),
  ]);

  private readonly _callback: ObserverCallback;
  private _native: NativeObserverInstance | undefined;

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

    if (entryTypes !== undefined) {
      if (!Array.isArray(entryTypes) || entryTypes.length === 0) {
        throw codedError(
          "ERR_INVALID_ARG_VALUE",
          "TypeError",
          'The "options.entryTypes" property must be a non-empty array of strings',
        );
      }
      for (const t of entryTypes) {
        if (
          typeof t !== "string" ||
          !(PerformanceObserver.supportedEntryTypes as readonly string[]).includes(t)
        ) {
          throw codedError(
            "ERR_INVALID_ARG_VALUE",
            "TypeError",
            `The property 'options.entryTypes' is invalid. Received '${String(t)}'`,
          );
        }
      }
    } else if (type !== undefined) {
      if (
        typeof type !== "string" ||
        !(PerformanceObserver.supportedEntryTypes as readonly string[]).includes(type)
      ) {
        throw codedError(
          "ERR_INVALID_ARG_VALUE",
          "TypeError",
          `The property 'options.type' is invalid. Received '${String(type)}'`,
        );
      }
    } else {
      throw codedError(
        "ERR_INVALID_ARG_VALUE",
        "TypeError",
        'The "options" argument must have either "entryTypes" or "type"',
      );
    }

    if (NativePerformanceObserver === undefined) {
      // No platform observer (non-DOM realm): records still land in
      // performance's entry buffer, takeRecords drains them lazily.
      return;
    }
    this._native = new NativePerformanceObserver((list) => {
      this._callback(toEntryList(list), this);
    });
    if (entryTypes !== undefined) {
      this._native.observe({ entryTypes: entryTypes as string[] });
    } else {
      this._native.observe({ type: type as string, buffered });
    }
  }

  disconnect(): void {
    this._native?.disconnect();
  }

  takeRecords(): PerformanceEntry[] {
    const records = this._native?.takeRecords();
    return records ? [...records] : [];
  }

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

// `performanceObserverCounts` — the shape Node's internal/test/binding
// `performance` binding exposes: a live {entryType: count} map of buffered
// performance entries. Derived from the realm performance buffer so a narrow
// binding stub can read it without the shim tracking anything itself.
const entryCountFor = (entryType: string): number => {
  const perf = (globalThis as { performance?: { getEntriesByType?: (t: string) => unknown[] } })
    .performance;
  return perf?.getEntriesByType?.(entryType)?.length ?? 0;
};
export const performanceObserverCounts: Record<string, number> = new Proxy(
  {} as Record<string, number>,
  {
    get: (_t, prop) => (typeof prop === "string" ? entryCountFor(prop) : undefined),
    ownKeys: () => {
      const perf = (globalThis as { performance?: { getEntries?: () => { entryType: string }[] } })
        .performance;
      const types = new Set((perf?.getEntries?.() ?? []).map((e) => e.entryType));
      return [...types];
    },
    getOwnPropertyDescriptor: (_t, prop) =>
      typeof prop === "string" && entryCountFor(prop) > 0
        ? { value: entryCountFor(prop), enumerable: true, configurable: true }
        : undefined,
  },
);

/**
 * Creates a node:perf_hooks shim — unenv's entries/histograms/constants plus
 * a working PerformanceObserver over the platform observer.
 */
export const createPerfHooksShim = (): typeof perf_hooks & {
  PerformanceObserver: typeof PerformanceObserver;
  PerformanceObserverEntryList: typeof PerformanceObserverEntryList;
} => {
  const base = perf_hooks as unknown as Record<string, unknown>;
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    PerformanceObserver,
    PerformanceObserverEntryList,
    performanceObserverCounts,
  }) as typeof perf_hooks & {
    PerformanceObserver: typeof PerformanceObserver;
    PerformanceObserverEntryList: typeof PerformanceObserverEntryList;
  };
};

export default createPerfHooksShim();
