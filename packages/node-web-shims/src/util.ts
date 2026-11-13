import unenvUtil from "unenv/node/util";
import { promisify as unenvPromisify } from "unenv/node/util";
import unenvTypes from "unenv/node/util/types";

export * from "unenv/node/util";

// unenv's util.mjs imports `node:util/types` itself, which lands as a dead
// `browser_external_*` namespace in consumer bundles — import the real,
// self-contained module directly instead.
export const types = unenvTypes;

/**
 * unenv's `promisify()` reads its own custom-promisify symbol (not Node's
 * `Symbol.for("nodejs.util.promisify.custom")`). Expose it so other shims
 * can tag their functions with the symbol unenv's promisify actually reads.
 */
export const customPromisifySymbol = (unenvUtil as unknown as { promisify: { custom: symbol } })
  .promisify.custom;

/**
 * `util.promisify` — Node reads `Symbol.for("nodejs.util.promisify.custom")`
 * (and keeps `.custom` pointing at it). unenv's version reads its own
 * module-local symbol, so a function tagged with Node's symbol (or vice
 * versa) is invisible. Try both.
 */
const promisify = <F extends (...args: any[]) => any>(fn: F) => {
  const tagged =
    (fn as Record<PropertyKey, unknown>)[Symbol.for("nodejs.util.promisify.custom")] ??
    (fn as Record<PropertyKey, unknown>)[customPromisifySymbol];
  if (tagged) return tagged as (...args: Parameters<F>) => Promise<unknown>;
  return unenvPromisify(fn as never);
};
promisify.custom = Symbol.for("nodejs.util.promisify.custom");

const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

interface InspectOptions {
  readonly depth?: number | null;
  readonly showHidden?: boolean;
  readonly maxArrayLength?: number;
  readonly maxStringLength?: number;
  readonly breakLength?: number;
  readonly compact?: boolean | number;
  readonly sorted?: boolean | ((a: string, b: string) => number);
  readonly numericSeparator?: boolean;
}

const escapeString = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

const fnName = (fn: Function): string => {
  const ctor = fn.constructor?.name;
  const name = fn.name ? `: ${fn.name}` : " (anonymous)";
  if (ctor === "AsyncFunction") return `[AsyncFunction${name}]`;
  if (ctor === "AsyncGeneratorFunction") return `[AsyncGeneratorFunction${name}]`;
  if (ctor === "GeneratorFunction") return `[GeneratorFunction${name}]`;
  if (/^class\s/.test(Function.prototype.toString.call(fn))) return `[class${name}]`;
  return `[Function${name}]`;
};

/**
 * `numericSeparator` grouping, matching Node ≥21: integer digits group in
 * threes from the right, fractional digits group in threes from the left,
 * the sign stays outside the grouping, and exponent/NaN/Infinity forms are
 * left untouched. BigInts group their decimal digits and keep the `n`.
 */
const groupIntDigits = (digits: string): string => {
  if (digits.length < 4) return digits;
  const first = digits.length % 3 === 0 ? 3 : digits.length % 3;
  let out = digits.slice(0, first);
  for (let i = first; i < digits.length; i += 3) {
    out += `_${digits.slice(i, i + 3)}`;
  }
  return out;
};

const groupFracDigits = (digits: string): string => {
  if (digits.length < 4) return digits;
  let out = digits.slice(0, 3);
  for (let i = 3; i < digits.length; i += 3) {
    out += `_${digits.slice(i, i + 3)}`;
  }
  return out;
};

const formatNumber = (n: number, numericSeparator: boolean): string => {
  if (Object.is(n, -0)) return "-0";
  const s = String(n);
  if (!numericSeparator || !Number.isFinite(n) || /[eE]/.test(s)) return s;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? "" : body.slice(dot + 1);
  const grouped =
    dot === -1
      ? groupIntDigits(intPart)
      : `${groupIntDigits(intPart)}.${groupFracDigits(fracPart)}`;
  return `${negative ? "-" : ""}${grouped}`;
};

const formatBigInt = (v: bigint, numericSeparator: boolean): string => {
  const s = `${v}`;
  if (!numericSeparator) return `${s}n`;
  const negative = s.startsWith("-");
  const digits = negative ? s.slice(1) : s;
  return `${negative ? "-" : ""}${groupIntDigits(digits)}n`;
};

const inspectValue = (
  value: unknown,
  opts: InspectOptions,
  depth: number,
  seen: Map<object, number>,
): string => {
  if (value === null) return "null";
  const numericSeparator = opts.numericSeparator === true;
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return String(value);
    case "number":
      // Node renders negative zero as '-0' (inspect(-0) === '-0').
      return formatNumber(value, numericSeparator);
    case "bigint":
      return formatBigInt(value, numericSeparator);
    case "symbol":
      return String(value);
    case "string": {
      const max = opts.maxStringLength ?? Infinity;
      const shown = value.length > max ? `${value.slice(0, max)}...` : value;
      return `'${escapeString(shown)}'`;
    }
    case "function":
      return fnName(value as Function);
  }

  const obj = value as Record<PropertyKey, unknown>;

  // User-defined [util.inspect.custom]
  const custom = obj[customInspectSymbol];
  if (typeof custom === "function") {
    try {
      return String(
        (custom as (d: number, o: InspectOptions, i: typeof inspect) => unknown)(
          depth,
          opts,
          inspect,
        ),
      );
    } catch {
      // fall through to default formatting
    }
  }

  if (seen.has(obj)) return `[Circular *${seen.get(obj)}]`;
  if (opts.depth !== null && depth > (opts.depth ?? 2)) {
    return Array.isArray(obj) ? "[Array]" : "[Object]";
  }

  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Error) {
    return `[${obj.name || "Error"}: ${obj.message}]`;
  }
  if (
    obj instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && obj instanceof SharedArrayBuffer)
  ) {
    return `${(obj as ArrayBuffer).constructor.name} { byteLength: ${(obj as ArrayBuffer).byteLength} }`;
  }
  if (ArrayBuffer.isView(obj)) {
    const ctor = obj.constructor.name;
    if (obj instanceof DataView) return `DataView { byteLength: ${obj.byteLength} }`;
    const arr = Array.from(obj as unknown as ArrayLike<number>).slice(
      0,
      opts.maxArrayLength ?? 100,
    );
    const suffix =
      (obj as unknown as ArrayLike<number>).length > arr.length
        ? `, ... ${(obj as unknown as ArrayLike<number>).length - arr.length} more items`
        : "";
    seen.set(obj, seen.size + 1);
    const inner = arr.map((v) => String(v)).join(", ");
    seen.delete(obj);
    return `${ctor}(${(obj as unknown as ArrayLike<number>).length}) [ ${inner}${suffix} ]`;
  }
  if (obj instanceof Promise) return "Promise { <pending> }";
  if (obj instanceof WeakMap) return "WeakMap { <items unknown> }";
  if (obj instanceof WeakSet) return "WeakSet { <items unknown> }";
  if (obj instanceof Map) {
    seen.set(obj, seen.size + 1);
    const entries = [...obj.entries()].map(
      ([k, v]) =>
        `${inspectValue(k, opts, depth + 1, seen)} => ${inspectValue(v, opts, depth + 1, seen)}`,
    );
    seen.delete(obj);
    return `Map(${obj.size}) { ${entries.join(", ")} }`;
  }
  if (obj instanceof Set) {
    seen.set(obj, seen.size + 1);
    const items = [...obj.values()].map((v) => inspectValue(v, opts, depth + 1, seen));
    seen.delete(obj);
    return `Set(${obj.size}) { ${items.join(", ")} }`;
  }

  seen.set(obj, seen.size + 1);
  try {
    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      const max = opts.maxArrayLength ?? 100;
      const items = obj.slice(0, max).map((v) => inspectValue(v, opts, depth + 1, seen));
      if (obj.length > max) items.push(`... ${obj.length - max} more items`);
      // preserve holes: inspect shows empty slots as <1 empty item>
      return `[ ${items.join(", ")} ]`;
    }
    let keys = Object.keys(obj);
    const sort = opts.sorted;
    if (sort === true) keys = keys.sort();
    else if (typeof sort === "function") keys = keys.sort(sort);
    const entries = keys.map((k) => {
      const v = inspectValue(obj[k], opts, depth + 1, seen);
      // Node drops quotes on identifier-ish keys
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${escapeString(k)}'`;
      return `${key}: ${v}`;
    });
    const ctorName =
      obj.constructor && obj.constructor !== Object ? `${obj.constructor.name} ` : "";
    if (entries.length === 0) return `${ctorName}{}`;
    return `${ctorName}{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(obj);
  }
};

/**
 * Node-compatible `util.inspect` — handles circular refs, depth limits, and
 * the `util.inspect.custom` symbol. unenv's version is a bare JSON.stringify
 * that throws on circular input.
 */
export const inspect = Object.assign(
  (value: unknown, options?: InspectOptions | boolean): string =>
    inspectValue(
      value,
      typeof options === "object" && options !== null ? options : {},
      0,
      new Map(),
    ),
  {
    custom: customInspectSymbol,
    defaultOptions: { depth: 2 },
  },
);

const FORMAT_SPECIFIER = /%[%sdifjoOc]/g;

/** Node renders negative zero as '-0' in every numeric conversion. */
const numberToString = (n: number, numericSeparator = false): string =>
  formatNumber(n, numericSeparator);

const formatImpl = (
  inspectOptions: InspectOptions | undefined,
  fmt: unknown,
  args: unknown[],
): string => {
  const numericSeparator = inspectOptions?.numericSeparator === true;
  if (fmt === undefined && args.length === 0) return "";
  if (typeof fmt !== "string") {
    return [fmt, ...args]
      .map((a) => (typeof a === "string" ? a : inspectValue(a, inspectOptions ?? {}, 0, new Map())))
      .join(" ");
  }
  let argIndex = 0;
  let out = fmt.replace(FORMAT_SPECIFIER, (spec) => {
    if (spec === "%%") return "%";
    if (argIndex >= args.length) return spec;
    const arg = args[argIndex++];
    switch (spec[1]) {
      case "s":
        // Node converts everything with String() except BigInt, -0, and
        // objects, which are inspected ('%s' of {} is '{}', not
        // '[object Object]').
        if (typeof arg === "string") return arg;
        if (typeof arg === "object" && arg !== null) {
          return inspectValue(arg, inspectOptions ?? {}, 0, new Map());
        }
        if (typeof arg === "bigint") return formatBigInt(arg, numericSeparator);
        return typeof arg === "number"
          ? numberToString(arg, numericSeparator)
          : String(arg as string);
      case "d":
        if (typeof arg === "bigint") return formatBigInt(arg, numericSeparator);
        if (typeof arg === "symbol") return "NaN";
        return numberToString(Number(arg), numericSeparator);
      case "i":
        if (typeof arg === "bigint") return formatBigInt(arg, numericSeparator);
        if (typeof arg === "symbol") return "NaN";
        return numberToString(Number.parseInt(String(arg), 10), numericSeparator);
      case "f":
        if (typeof arg === "symbol") return "NaN";
        return numberToString(Number(arg), numericSeparator);
      case "j":
        try {
          return `${JSON.stringify(arg)}`;
        } catch {
          return "[Circular: ~]";
        }
      case "o":
      case "O":
        return inspectValue(arg, inspectOptions ?? {}, 0, new Map());
      case "c":
        return "";
      default:
        return spec;
    }
  });
  // leftover args are appended, inspected
  for (; argIndex < args.length; argIndex++) {
    const arg = args[argIndex];
    out += ` ${typeof arg === "string" ? arg : inspectValue(arg, inspectOptions ?? {}, 0, new Map())}`;
  }
  return out;
};

/**
 * `util.format` — unlike unenv's, tolerates non-string first arguments and
 * inspects trailing args (`format('a', {b: 2})` → `'a { b: 2 }'`).
 */
export const format = (fmt: unknown, ...args: unknown[]): string =>
  formatImpl(undefined, fmt, args);

export const formatWithOptions = (
  inspectOptions: InspectOptions,
  fmt: unknown,
  ...args: unknown[]
): string => formatImpl(inspectOptions, fmt, args);

export const callbackify = <T extends unknown[]>(fn: (...args: [...T]) => Promise<unknown>) => {
  const callbackified = (...args: [...T, (err: unknown, value?: unknown) => void]) => {
    const cb = args.pop() as (err: unknown, value?: unknown) => void;
    Promise.resolve()
      .then(() => fn(...(args as unknown as T)))
      .then(
        (v) => cb(null, v),
        (e) => cb(e),
      );
  };
  return callbackified;
};

export const toUSVString = (val: unknown): string => {
  const s = String(val);
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
};

const util = {
  ...unenvUtil,
  types: unenvTypes,
  inspect,
  format,
  formatWithOptions,
  callbackify,
  toUSVString,
  promisify,
};

/**
 * Creates a node:util shim. Overrides unenv's `format`/`inspect` (which broke
 * on non-string format args and circular objects) and wires `types` to the
 * real `unenv/node/util/types` module rather than the dead `node:util/types`
 * import inside unenv's util.
 */
export const createUtilShim = (): typeof util => {
  return util;
};

export default createUtilShim();
