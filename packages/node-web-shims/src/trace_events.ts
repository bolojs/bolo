/**
 * `node:trace_events` — a faithful port of the JS half of Node's
 * lib/trace_events.js. There is no native tracing backend in the browser,
 * so enabling a `Tracing` object only tracks category state: `enabled`,
 * `getEnabledCategories()`, and the `nodejs.util.inspect.custom` rendering
 * all behave like Node, but no trace data is emitted anywhere.
 *
 * `destroy()` is not part of Node's `Tracing` (verified against v22
 * lib/trace_events.js); it is provided as a small extension — it disables
 * the object and makes later `enable()` calls a no-op returning `false`.
 */

const kMaxTracingCount = 10;

const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

const enabledTracingObjects = new Set<Tracing>();

/** Categories per instance, readable from `getEnabledCategories()`. */
const categorySets = new WeakMap<Tracing, string[]>();

const receivedText = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return `type string ('${value}')`;
    case "number":
    case "boolean":
    case "bigint":
      return `type ${typeof value} (${String(value)})`;
    case "function":
      return `function ${(value as { name?: string }).name || "<anonymous>"}`;
    default:
      return `an instance of ${(value as object).constructor?.name || "Object"}`;
  }
};

const invalidArgType = (
  name: string,
  nameKind: "argument" | "property",
  expected: string,
  value: unknown,
): TypeError =>
  Object.assign(
    new TypeError(`The "${name}" ${nameKind} must be ${expected}. Received ${receivedText(value)}`),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

const inspectString = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export class Tracing {
  #enabled = false;
  #destroyed = false;

  constructor(categories: string[]) {
    categorySets.set(this, categories);
  }

  enable(): boolean {
    if (this.#destroyed) return false;
    if (!this.#enabled) {
      this.#enabled = true;
      enabledTracingObjects.add(this);
      if (enabledTracingObjects.size > kMaxTracingCount) {
        const proc = (globalThis as { process?: { emitWarning?: (msg: string) => void } }).process;
        proc?.emitWarning?.(
          "Possible trace_events memory leak detected. There are more than " +
            `${kMaxTracingCount} enabled Tracing objects.`,
        );
      }
    }
    return true;
  }

  disable(): void {
    if (this.#enabled) {
      this.#enabled = false;
      enabledTracingObjects.delete(this);
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** A comma-separated list of the trace event categories covered by this object. */
  get categories(): string {
    return (categorySets.get(this) ?? []).join(",");
  }

  /** `true` once {@link destroy} has been called. */
  get destroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * Not part of Node's `Tracing`. Disables this object and makes later
   * `enable()` calls a no-op returning `false`.
   */
  destroy(): void {
    this.#destroyed = true;
    this.disable();
  }

  [customInspectSymbol](depth: number): unknown {
    if (typeof depth === "number" && depth < 0) return this;
    return `Tracing { enabled: ${this.enabled}, categories: ${inspectString(this.categories)} }`;
  }
}

export interface CreateTracingOptions {
  categories: string[];
}

export const createTracing = (options: CreateTracingOptions): Tracing => {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidArgType("options", "argument", "of type object", options);
  }

  const { categories } = options;
  if (!Array.isArray(categories)) {
    throw invalidArgType("options.categories", "property", "an instance of Array", categories);
  }
  for (let i = 0; i < categories.length; i++) {
    if (typeof categories[i] !== "string") {
      throw invalidArgType(`options.categories[${i}]`, "property", "of type string", categories[i]);
    }
  }
  if (categories.length <= 0) {
    throw Object.assign(new Error("At least one category is required"), {
      code: "ERR_TRACE_EVENTS_CATEGORY_REQUIRED",
    });
  }

  return new Tracing(categories);
};

/**
 * Returns a comma-separated list of all currently-enabled trace event
 * categories (the union of all enabled `Tracing` objects), or `undefined`
 * when none are enabled.
 */
export const getEnabledCategories = (): string | undefined => {
  if (enabledTracingObjects.size === 0) return undefined;
  const categories = new Set<string>();
  for (const tracing of enabledTracingObjects) {
    for (const category of categorySets.get(tracing) ?? []) categories.add(category);
  }
  return [...categories].sort().join(",");
};

export interface TraceEventsModule {
  createTracing: typeof createTracing;
  getEnabledCategories: typeof getEnabledCategories;
}

export const createTraceEventsShim = (): TraceEventsModule => ({
  createTracing,
  getEnabledCategories,
});

export default createTraceEventsShim();
