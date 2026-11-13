import { nullPrototypeConstructorName, nullPrototypeInfoOf } from "./constructor-name.js";

/**
 * Node's `strEscape` (lib/internal/util/inspect.js): escapes control
 * characters, the quote character and the backslash. Prefers single quotes,
 * falls back to double quotes / backticks when the content contains them.
 */
// Node's `meta` table (lib/internal/util/inspect.js): the escaped form of
// every code point below 0xA0, with uppercase hex digits.
const META: string[] = [];
for (let i = 0; i < 0xa0; i++) META[i] = `\\x${i.toString(16).toUpperCase().padStart(2, "0")}`;
META[0x08] = "\\b";
META[0x09] = "\\t";
META[0x0a] = "\\n";
META[0x0c] = "\\f";
META[0x0d] = "\\r";
META[0x27] = "\\'";
META[0x5c] = "\\\\";

const _STR_ESCAPE_SEQUENCES =
  /[\0-\x1f\x27\x5c\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/* eslint-disable no-control-regex */
const STR_ESCAPE_SEQUENCES_G =
  /[\0-\x1f\x27\x5c\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const STR_ESCAPE_SEQUENCES_SINGLE =
  /[\0-\x1f\x5c\x7f-\x9f\u0800-\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const STR_ESCAPE_SEQUENCES_SINGLE_G =
  /[\0-\x1f\x5c\x7f-\x9f\u0800-\uFEFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/* eslint-enable no-control-regex */
const KEY_STR_RE = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const K_MIN_LINE_LENGTH = 16;
const NUMBER_RE = /^(0|[1-9][0-9]*)$/;
const BUILT_IN_OBJECTS = new Set(
  Object.getOwnPropertyNames(globalThis).filter((n) => /^[A-Z][a-zA-Z0-9]+$/.test(n)),
);

const escapeFn = (str: string): string => {
  const code = str.charCodeAt(0);
  return code < META.length ? META[code] : `\\u${code.toString(16)}`;
};

export const strEscape = (str: string): string => {
  let escapeReplace = STR_ESCAPE_SEQUENCES_G;
  let quote = "'";
  if (str.includes("'")) {
    if (!str.includes('"')) {
      quote = '"';
      escapeReplace = STR_ESCAPE_SEQUENCES_SINGLE_G;
    } else if (!str.includes("`") && !str.includes("${")) {
      quote = "`";
      escapeReplace = STR_ESCAPE_SEQUENCES_SINGLE_G;
    }
  }
  const out = str.replace(escapeReplace, escapeFn);
  return `${quote}${out}${quote}`;
};

/**
 * Node's `stylizeWithColor` — maps a style name to an ANSI code pair via
 * `inspect.styles`/`inspect.colors`.
 */
const COLORS: Record<string, [number, number]> = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  doubleunderline: [21, 24],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgGray: [100, 49],
  bgRedBright: [101, 49],
  bgGreenBright: [102, 49],
  bgYellowBright: [103, 49],
  bgBlueBright: [104, 49],
  bgMagentaBright: [105, 49],
  bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};
COLORS.grey = COLORS.gray;
COLORS.blackBright = COLORS.gray;
COLORS.bgGrey = COLORS.bgGray;
COLORS.bgBlackBright = COLORS.bgGray;
COLORS.faint = COLORS.dim;
COLORS.crossedout = COLORS.strikethrough;
COLORS.strikeThrough = COLORS.strikethrough;
COLORS.crossedOut = COLORS.strikethrough;
COLORS.conceal = COLORS.hidden;
COLORS.swapColors = COLORS.inverse;
COLORS.swapcolors = COLORS.inverse;
COLORS.doubleUnderline = COLORS.doubleunderline;
// Node exposes the aliases as non-enumerable properties: `Object.keys` lists
// only the canonical colour names, `getOwnPropertyNames` lists both.
for (const alias of [
  "grey",
  "blackBright",
  "bgGrey",
  "bgBlackBright",
  "faint",
  "crossedout",
  "strikeThrough",
  "crossedOut",
  "conceal",
  "swapColors",
  "swapcolors",
  "doubleUnderline",
]) {
  Object.defineProperty(COLORS, alias, {
    value: COLORS[alias as keyof typeof COLORS],
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

const STYLES: Record<string, string> = {
  special: "cyan",
  number: "yellow",
  bigint: "yellow",
  boolean: "yellow",
  undefined: "gray",
  null: "bold",
  string: "green",
  symbol: "green",
  date: "magenta",
  // "name": intentionally not styled
  regexp: "red",
  module: "underline",
};

const stylizeNoColor = (str: string): string => str;
const stylizeWithColor = (str: string, styleType?: string): string => {
  const style = styleType === undefined ? undefined : STYLES[styleType];
  if (style !== undefined) {
    const color = COLORS[style];
    if (color !== undefined) return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }
  return str;
};

/** Node's `removeColors` — strips ANSI sequences for length measurement. */
const ANSI_RE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*" +
    "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);
export const removeColors = (str: string): string => str.replace(ANSI_RE, "");

// ---------------------------------------------------------------------------
// Numeric formatting
// ---------------------------------------------------------------------------

const addNumericSeparator = (integerString: string): string => {
  let result = "";
  let i = integerString.length;
  const start = integerString.startsWith("-") ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${integerString.slice(i - 3, i)}${result}`;
  }
  return i === integerString.length ? integerString : `${integerString.slice(0, i)}${result}`;
};

const addNumericSeparatorEnd = (integerString: string): string => {
  let result = "";
  let i = 0;
  for (; i < integerString.length - 3; i += 3) {
    result += `${integerString.slice(i, i + 3)}_`;
  }
  return i === 0 ? integerString : `${result}${integerString.slice(i)}`;
};

export const formatNumber = (
  stylize: StylizeFn,
  number: number,
  numericSeparator: boolean,
): string => {
  if (!numericSeparator) {
    if (Object.is(number, -0)) return stylize("-0", "number");
    return stylize(`${number}`, "number");
  }
  const integer = Math.trunc(number);
  const string = `${integer}`;
  if (integer === number) {
    if (!Number.isFinite(number) || string.includes("e")) return stylize(string, "number");
    return stylize(`${addNumericSeparator(string)}`, "number");
  }
  if (Number.isNaN(number)) return stylize(string, "number");
  return stylize(
    `${addNumericSeparator(string)}.${addNumericSeparatorEnd(String(number).slice(string.length + 1))}`,
    "number",
  );
};

export const formatBigInt = (
  stylize: StylizeFn,
  bigint: bigint,
  numericSeparator: boolean,
): string => {
  const string = `${bigint}`;
  if (!numericSeparator) return stylize(`${string}n`, "bigint");
  return stylize(`${addNumericSeparator(string)}n`, "bigint");
};

/** Node's `formatPrimitive` (without the long-string line-splitting trailer). */
const formatPrimitive = (stylize: StylizeFn, value: unknown, ctx: Ctx): string => {
  // Node special-cases the `<pending>` / `<rejected>` promise markers so they
  // are not quoted like ordinary strings.
  if (value === "<pending>" || value === "<rejected>") return stylize(value, "special");
  if (typeof value === "string") {
    const original = value;
    let trailer = "";
    let subject = value;
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      subject = original.slice(0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? "s" : ""}`;
    }
    // Long strings that contain line breaks are split across lines like Node
    // does (`'a\n' +\n  'b'`), each escaped chunk on its own line.
    if (ctx.compact !== true && subject.length > K_MIN_LINE_LENGTH && subject.length > ctx.breakLength - ctx.indentationLvl - 4) {
      return (
        subject
          .split(/(?<=\n)/)
          .map((line) => stylize(strEscape(line), "string"))
          .join(` +\n${" ".repeat(ctx.indentationLvl + 2)}`) + trailer
      );
    }
    return `${stylize(strEscape(subject), "string")}${trailer}`;
  }
  if (typeof value === "number") return formatNumber(stylize, value, ctx.numericSeparator);
  if (typeof value === "bigint") return formatBigInt(stylize, value, ctx.numericSeparator);
  if (typeof value === "boolean") return stylize(`${value}`, "boolean");
  if (typeof value === "undefined") return stylize("undefined", "undefined");
  return stylize(String(value), "symbol");
};

// ---------------------------------------------------------------------------
// Core inspection
// ---------------------------------------------------------------------------

export const customInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

const K_OBJECT_TYPE = 0;
const K_ARRAY_TYPE = 1;
const _K_ARRAY_EXTRAS_TYPE = 2;

export interface InspectOptions {
  showHidden?: boolean;
  depth?: number | null;
  colors?: boolean;
  customInspect?: boolean;
  showProxy?: boolean;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  breakLength?: number;
  compact?: boolean | number;
  sorted?: boolean | ((a: string, b: string) => number);
  getters?: boolean | "get" | "set";
  numericSeparator?: boolean;
  stylize?: (str: string, styleType?: string) => string;
}

interface Ctx {
  budget: Record<number, number>;
  indentationLvl: number;
  seen: unknown[];
  currentDepth: number;
  circular?: Map<unknown, number>;
  stylize: (str: string, styleType?: string) => string;
  showHidden: boolean;
  depth: number | null;
  colors: boolean;
  customInspect: boolean;
  showProxy: boolean;
  maxArrayLength: number;
  maxStringLength: number;
  breakLength: number;
  compact: boolean | number;
  sorted: boolean | ((a: string, b: string) => number);
  getters: boolean | "get" | "set";
  numericSeparator: boolean;
  /** The raw options object the caller passed, kept for custom inspectors. */
  userOptions?: Record<string, unknown>;
}

export const inspectDefaultOptions: InspectOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};

const REMAINING_TEXT = (remaining: number): string =>
  `... ${remaining} more item${remaining > 1 ? "s" : ""}`;

const UNDETECTABLE = (v: unknown): boolean => typeof v === "undefined" && v !== undefined;

const isInstanceof = (object: unknown, proto: unknown): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return object instanceof (proto as any);
  } catch {
    return false;
  }
};

/**
 * Node's `getConstructorName` without the cross-realm/internal fallback: walk
 * the prototype chain looking for a `constructor` own property whose `.name`
 * is non-empty and whose prototype `value` is an actual ancestor.
 */
const getConstructorName = (
  obj: object | null,
  ctx: Ctx,
  recurseTimes: number,
  protoProps: string[] | undefined,
): string | null => {
  let firstProto: object | null | undefined;
  const tmp = obj;
  while (obj || UNDETECTABLE(obj)) {
    const descriptor = Object.getOwnPropertyDescriptor(obj!, "constructor");
    if (
      descriptor !== undefined &&
      typeof descriptor.value === "function" &&
      descriptor.value.name !== "" &&
      isInstanceof(tmp, descriptor.value)
    ) {
      if (
        protoProps !== undefined &&
        (firstProto !== obj || !BUILT_IN_OBJECTS.has(descriptor.value.name))
      ) {
        addPrototypeProperties(ctx, tmp!, firstProto ?? tmp!, recurseTimes, protoProps);
      }
      return String(descriptor.value.name);
    }
    obj = Object.getPrototypeOf(obj!);
    if (firstProto === undefined) firstProto = obj;
  }
  if (firstProto === null) {
    // No `constructor` anywhere on the prototype chain (null-prototype
    // object): Node falls back to V8's `Object::GetConstructorName`, which
    // reads the object's creation map. That map is not observable from
    // JavaScript, but the object still remembers the constructor it was
    // created with — `Object.prototype.toString` cannot see it either.
    // V8 stores it on the map, so the only observable approximation is the
    // object's own `Symbol.toStringTag`/`constructor` — which are gone.
    // Node's own rendering for a null-prototype object created from a class
    // is `[Foo: null prototype] {}`; the class name cannot be recovered from
    // the instance once the prototype is dropped, so use the generic tag.
    return null;
  }
  // A prototype chain exists but no `constructor` matched — the object was
  // created with a custom prototype whose `constructor` is not on the chain.
  return null;
};

const getPrefix = (
  constructor: string | null,
  tag: string,
  fallback: string,
  size = "",
): string => {
  if (constructor === null) {
    if (tag !== "" && fallback !== tag) return `[${fallback}${size}: null prototype] [${tag}] `;
    return `[${fallback}${size}: null prototype] `;
  }
  if (tag !== "" && constructor !== tag) return `${constructor}${size} [${tag}] `;
  return `${constructor}${size} `;
};

type StylizeFn = (str: string, styleType?: string) => string;

const CtxStyle = (value: object, constructor: string | null, tag: string): string => {
  let fallback = "";
  if (constructor === null) {
    // Node gets the creation-map constructor name from V8; the shim's
    // setPrototypeOf recorder is the JS-reachable approximation. When the
    // name equals the tag, Node falls back to "Object" so the two never
    // render as the same word twice.
    fallback = nullPrototypeConstructorName(value) ?? "Object";
    if (fallback === tag) fallback = "Object";
  }
  return getPrefix(constructor, tag, fallback);
};

const addPrototypeProperties = (
  ctx: Ctx,
  main: object,
  obj: object,
  recurseTimes: number,
  output: string[],
): void => {
  let depth = 0;
  let keys: (string | symbol)[] = [];
  let keySet: Set<string | symbol> | undefined;
  do {
    if (depth !== 0 || main === obj) {
      obj = Object.getPrototypeOf(obj) as object;
      if (obj === null) return;
      const descriptor = Object.getOwnPropertyDescriptor(obj, "constructor");
      if (
        descriptor !== undefined &&
        typeof descriptor.value === "function" &&
        BUILT_IN_OBJECTS.has(descriptor.value.name)
      ) {
        return;
      }
    }
    if (depth === 0) {
      keySet = new Set();
    } else {
      keys.forEach((key) => keySet!.add(key));
    }
    keys = Reflect.ownKeys(obj);
    ctx.seen.push(main);
    for (const key of keys) {
      if (
        key === "constructor" ||
        Object.prototype.hasOwnProperty.call(main, key) ||
        (depth !== 0 && keySet!.has(key))
      ) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (typeof desc?.value === "function") continue;
      const value = formatProperty(ctx, obj, recurseTimes, key, K_OBJECT_TYPE, desc, main);
      if (ctx.colors) {
        output.push(`\u001b[2m${value}\u001b[22m`);
      } else {
        output.push(value);
      }
    }
    ctx.seen.pop();
  } while (++depth !== 3);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * Cross-realm ArrayBuffers (created in another `vm` context) fail
 * `instanceof`; Node checks the internal slot via the object tag.
 */
/** The single-letter flags a RegExp renders, in the order Node prints them. */
const FLAG_LETTERS = ["d", "g", "i", "m", "s", "u", "v", "y"] as const;

/**
 * Node's `isAnyArrayBuffer` / `isArrayBuffer` / `isDataView` — V8 brand
 * checks on the internal slot. `instanceof` fails once the prototype has
 * been dropped and `Object.prototype.toString` follows `Symbol.toStringTag`,
 * so the intrinsic `byteLength` accessor is the reliable probe.
 */
const hasArrayBufferSlot = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  try {
    const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as
      | (() => number)
      | undefined;
    getter?.call(value);
    return true;
  } catch {
    return false;
  }
};
const isAnyArrayBuffer = (value: unknown): value is ArrayBuffer => {
  if (hasArrayBufferSlot(value)) return true;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value !== null &&
    typeof value === "object"
  ) {
    try {
      const getter = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")
        ?.get as (() => number) | undefined;
      getter?.call(value);
      return true;
    } catch {
      return false;
    }
  }
  return false;
};
const isArrayBuffer = (value: unknown): value is ArrayBuffer => hasArrayBufferSlot(value);
const isDataView = (value: unknown): value is DataView => {
  if (value === null || typeof value !== "object") return false;
  try {
    const getter = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get as
      | (() => number)
      | undefined;
    getter?.call(value);
    return true;
  } catch {
    return false;
  }
};
/**
 * Node's `isPromise` / `isWeakSet` / `isWeakMap` — V8 brand checks on the
 * internal slot. `Object.prototype.toString` cannot be used: an own
 * `Symbol.toStringTag` overrides it, and a null-prototype instance loses the
 * tag entirely.
 */
const isPromise = (value: unknown): value is Promise<unknown> => {
  if (value === null || typeof value !== "object") return false;
  try {
    Promise.prototype.then.call(value, undefined, undefined);
    return true;
  } catch {
    return false;
  }
};
const isWeakSet = (value: unknown): value is WeakSet<object> => {
  if (value === null || typeof value !== "object") return false;
  try {
    WeakSet.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
};
const isWeakMap = (value: unknown): value is WeakMap<object, unknown> => {
  if (value === null || typeof value !== "object") return false;
  try {
    WeakMap.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
};
/**
 * Node's `isSet` / `isMap` — V8 brand checks on the collection's internal
 * slot. `Object.prototype.toString` cannot be used: an own
 * `Symbol.toStringTag` overrides it, so a plain object claiming to be a
 * `Map` would be mistaken for one.
 */
const isSet = (value: unknown): value is Set<unknown> => {
  if (value === null || typeof value !== "object") return false;
  try {
    Set.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
};
const isMap = (value: unknown): value is Map<unknown, unknown> => {
  if (value === null || typeof value !== "object") return false;
  try {
    Map.prototype.has.call(value, undefined);
    return true;
  } catch {
    return false;
  }
};
/**
 * Node's `isMapIterator` / `isSetIterator` — V8 brand checks on the
 * iterator's internal slot. `Object.prototype.toString` cannot be used:
 * an own `Symbol.toStringTag` overrides it, while the internal slot is
 * still present. There is no JS-reachable brand check for iterators, so
 * the intrinsic prototype is the only reliable marker.
 */
const MAP_ITERATOR_PROTO = Object.getPrototypeOf(new Map().keys());
const SET_ITERATOR_PROTO = Object.getPrototypeOf(new Set().keys());
const isMapIterator = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === MAP_ITERATOR_PROTO;
const isSetIterator = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === SET_ITERATOR_PROTO;
/**
 * Node's `isRegExp` / `isDate` — V8 brand checks on the internal slot.
 * `instanceof` fails once the prototype has been dropped, while the
 * intrinsic method still works.
 */
const isRegExp = (value: unknown): value is RegExp => {
  if (value === null || typeof value !== "object") return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "source");
    (descriptor?.get as (() => string) | undefined)?.call(value);
    return true;
  } catch {
    return false;
  }
};
const isDate = (value: unknown): value is Date => {
  if (value === null || typeof value !== "object") return false;
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    return false;
  }
};
const isError = (value: unknown): value is Error => {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.toString.call(value) === "[object Error]") return true;
  // A null-prototype error instance keeps V8's error slot but loses both
  // `instanceof` and the toString tag; the setPrototypeOf recorder knows.
  return nullPrototypeInfoOf(value)?.isError === true;
};
/**
 * Node's `isBoxedPrimitive` — a V8 brand check on the wrapper's internal
 * slot. `Object.prototype.toString` cannot be used here: a custom
 * `Symbol.toStringTag` overrides it, while the internal slot is still
 * present. Calling the prototype's `valueOf` throws exactly when the
 * internal slot is missing, so a successful call proves the brand.
 */
const hasInternalSlot = (value: unknown, fn: (this: unknown) => unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  try {
    Function.prototype.call.call(fn, value);
    return true;
  } catch {
    return false;
  }
};

const isBoxedPrimitive = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  return (
    hasInternalSlot(value, Number.prototype.valueOf) ||
    hasInternalSlot(value, String.prototype.valueOf) ||
    hasInternalSlot(value, Boolean.prototype.valueOf) ||
    hasInternalSlot(value, Symbol.prototype.valueOf) ||
    (typeof BigInt === "function" && hasInternalSlot(value, BigInt.prototype.valueOf))
  );
};
const isArgumentsObject = (value: unknown): boolean =>
  Object.prototype.toString.call(value) === "[object Arguments]";

/**
 * Node's `getOwnNonIndexProperties` — own property names except array
 * indices. An index is a canonical unsigned 32-bit integer *below*
 * `2 ** 32 - 1`; the last slot (`2 ** 32 - 1`) and larger keys are ordinary
 * properties.
 */
const getOwnNonIndexProperties = (value: object, showHidden: boolean): (string | symbol)[] => {
  const all = showHidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
  const symbols = Object.getOwnPropertySymbols(value);
  const symbolFilter = showHidden
    ? () => true
    : (k: symbol) => Object.prototype.propertyIsEnumerable.call(value, k);
  const symbolKeys = symbols.filter(symbolFilter);
  return [...all, ...symbolKeys].filter((k) =>
    typeof k === "symbol" ? true : !(NUMBER_RE.test(k) && Number(k) < 2 ** 32 - 1)
  );
};

const getKeys = (value: object, showHidden: boolean): (string | symbol)[] => {
  let keys: (string | symbol)[];
  const symbols = Object.getOwnPropertySymbols(value);
  if (showHidden) {
    keys = Object.getOwnPropertyNames(value);
  } else {
    keys = Object.keys(value);
  }
  if (symbols.length !== 0) {
    // With `showHidden`, non-enumerable symbols are included too (Node's
    // ALL_PROPERTIES filter); otherwise only enumerable ones are listed.
    const filter = showHidden
      ? () => true
      : (key: symbol) => Object.prototype.propertyIsEnumerable.call(value, key);
    keys.push(...symbols.filter(filter));
  }
  return keys;
};

const hexSlice = (u8: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let i = start; i < end; i++) out += u8[i].toString(16).padStart(2, "0");
  return out;
};

const formatArrayBuffer = (ctx: Ctx, value: ArrayBuffer): string[] => {
  let buffer: Uint8Array;
  try {
    buffer = new Uint8Array(value);
  } catch {
    return [ctx.stylize("(detached)", "special")];
  }
  let str = hexSlice(buffer, 0, Math.min(ctx.maxArrayLength, buffer.length))
    .replace(/(.{2})/g, "$1 ")
    .trim();
  const remaining = buffer.length - ctx.maxArrayLength;
  if (remaining > 0) str += ` ... ${remaining} more byte${remaining > 1 ? "s" : ""}`;
  return [`${ctx.stylize("[Uint8Contents]", "special")}: <${str}>`];
};

const formatSpecialArray = (
  ctx: Ctx,
  value: unknown[],
  recurseTimes: number,
  maxLength: number,
  output: string[],
  i: number,
): string[] => {
  const keys = Object.keys(value);
  let index = i;
  for (; i < keys.length && output.length < maxLength; i++) {
    const key = keys[i];
    const tmp = Number(key);
    // Indices above the array length are ordinary properties, not elements:
    // stop the element walk but keep them as properties.
    if (tmp >= 2 ** 32 - 1) break;
    if (`${index}` !== key) {
      if (NUMBER_RE.test(key) === false) break;
      const emptyItems = tmp - index;
      const ending = emptyItems > 1 ? "s" : "";
      output.push(ctx.stylize(`<${emptyItems} empty item${ending}>`, "undefined"));
      index = tmp;
      if (output.length === maxLength) break;
    }
    output.push(formatProperty(ctx, value, recurseTimes, key, K_ARRAY_TYPE));
    index++;
  }
  const remaining = value.length - index;
  if (output.length !== maxLength) {
    if (remaining > 0) {
      const ending = remaining > 1 ? "s" : "";
      output.push(ctx.stylize(`<${remaining} empty item${ending}>`, "undefined"));
    }
  } else if (remaining > 0) {
    output.push(REMAINING_TEXT(remaining));
  }
  return output;
};

const formatArray = (ctx: Ctx, value: unknown[], recurseTimes: number): string[] => {
  const valLen = value.length;
  const len = Math.min(Math.max(0, ctx.maxArrayLength), valLen);
  const remaining = valLen - len;
  const output: string[] = [];
  for (let i = 0; i < len; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
    }
    output.push(formatProperty(ctx, value, recurseTimes, String(i), K_ARRAY_TYPE));
  }
  if (remaining > 0) output.push(REMAINING_TEXT(remaining));
  return output;
};

const formatTypedArray = (
  value: unknown[] & ArrayLike<unknown>,
  length: number,
  ctx: Ctx,
  _ignored: unknown,
  recurseTimes: number,
): string[] => {
  const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
  const remaining = value.length - maxLength;
  const output: string[] = Array.from({ length: maxLength });
  // Node picks the element formatter from the view's *own* `length`, which
  // can be redefined to a negative value.
  const elementFormatter =
    value.length > 0 && typeof value[0] === "number"
      ? (s: StylizeFn, v: unknown, ns: boolean) => formatNumber(s, v as number, ns)
      : (s: StylizeFn, v: unknown, ns: boolean) => formatBigInt(s, v as bigint, ns);
  for (let i = 0; i < maxLength; ++i) {
    output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
  }
  if (remaining > 0) output[maxLength] = REMAINING_TEXT(remaining);
  if (ctx.showHidden) {
    // `.buffer` goes last, it is not a primitive like the others. All besides
    // `BYTES_PER_ELEMENT` are actually getters.
    ctx.indentationLvl += 2;
    for (const key of ["BYTES_PER_ELEMENT", "length", "byteLength", "byteOffset", "buffer"]) {
      const str = formatValue(ctx, (value as unknown as Record<string, unknown>)[key], recurseTimes, true);
      output.push(`[${key}]: ${str}`);
    }
    ctx.indentationLvl -= 2;
  }
  return output;
};

/**
 * Brand-safe accessors for typed arrays.
 *
 * A typed array whose prototype was dropped loses `length`, `buffer` and
 * `BYTES_PER_ELEMENT`, but the `%TypedArray%.prototype` accessors read the
 * V8 internal slots and still work.
 */
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBrandSafe = {
  length: (value: unknown): number => {
    const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "length")?.get as
      | (() => number)
      | undefined;
    return getter?.call(value) ?? 0;
  },
  byteLength: (value: unknown): number => {
    const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength")?.get as
      | (() => number)
      | undefined;
    return getter?.call(value) ?? 0;
  },
  byteOffset: (value: unknown): number => {
    const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset")?.get as
      | (() => number)
      | undefined;
    return getter?.call(value) ?? 0;
  },
  buffer: (value: unknown): ArrayBuffer | undefined => {
    const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer")?.get as
      | (() => ArrayBuffer)
      | undefined;
    return getter?.call(value);
  },
  bytesPerElement: (value: unknown): number => {
    const ctor = (value as { constructor?: { BYTES_PER_ELEMENT?: number } })?.constructor;
    if (ctor?.BYTES_PER_ELEMENT !== undefined) return ctor.BYTES_PER_ELEMENT;
    // A null-prototype view has no `constructor`; recover it from the
    // internal slot's tag (e.g. "Uint8Array").
    const name = typedArrayBrandSafe.name(value);
    const globalCtor = (globalThis as Record<string, unknown>)[name] as
      | { BYTES_PER_ELEMENT?: number }
      | undefined;
    return globalCtor?.BYTES_PER_ELEMENT ?? 1;
  },
  /**
   * The typed array's constructor name, e.g. `Uint8Array`. A null-prototype
   * view has no `constructor`, so the name is recovered from the internal
   * slot via `%TypedArray%.prototype[Symbol.toStringTag]`.
   */
  name: (value: unknown): string => {
    const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, Symbol.toStringTag)?.get as
      | (() => string)
      | undefined;
    return getter?.call(value) ?? "TypedArray";
  },
};

/**
 * Brand-safe accessors for `Map`/`Set`.
 *
 * A collection whose prototype was dropped (`Object.setPrototypeOf(map,
 * null)`) no longer exposes `size`, `entries` or `values` through the
 * prototype chain, but V8 keeps the internal slots. Node reaches the
 * intrinsics directly, so the shim does the same.
 */
const setBrandSafe = {
  size: (value: Set<unknown>): number => {
    const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, "size");
    return (descriptor?.get as (() => number) | undefined)?.call(value) ?? 0;
  },
  values: (value: Set<unknown>): Iterable<unknown> =>
    Set.prototype.values.call(value),
};

const mapBrandSafe = {
  size: (value: Map<unknown, unknown>): number => {
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, "size");
    return (descriptor?.get as (() => number) | undefined)?.call(value) ?? 0;
  },
  entries: (value: Map<unknown, unknown>): Iterable<[unknown, unknown]> =>
    Map.prototype.entries.call(value),
};

const formatSet = (
  value: Set<unknown>,
  ctx: Ctx,
  _ignored: unknown,
  recurseTimes: number,
): string[] => {
  const length = setBrandSafe.size(value);
  const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output: string[] = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const v of setBrandSafe.values(value)) {
    if (i >= maxLength) break;
    output.push(formatValue(ctx, v, recurseTimes));
    i++;
  }
  if (remaining > 0) output.push(REMAINING_TEXT(remaining));
  ctx.indentationLvl -= 2;
  return output;
};

const formatMap = (
  value: Map<unknown, unknown>,
  ctx: Ctx,
  _ignored: unknown,
  recurseTimes: number,
): string[] => {
  const length = mapBrandSafe.size(value);
  const maxLength = Math.min(Math.max(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output: string[] = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const [k, v] of mapBrandSafe.entries(value)) {
    if (i >= maxLength) break;
    output.push(`${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`);
    i++;
  }
  if (remaining > 0) output.push(REMAINING_TEXT(remaining));
  ctx.indentationLvl -= 2;
  return output;
};

const formatWeakCollection = (ctx: Ctx, _value?: unknown, _recurseTimes?: number): string[] => [
  ctx.stylize("<items unknown>", "special"),
];

/**
 * Node's `previewEntries` — a snapshot of an iterator's remaining entries.
 *
 * The native binding returns the entries as a flat array; when the iterator
 * yields `[key, value]` pairs the flat array holds both halves and a flag
 * says the pairs were key-value shaped. V8's snapshot is cached on the
 * iterator itself, so inspecting the same iterator twice does not consume
 * it; this shim keeps the same behaviour with a WeakMap.
 */
const previewCache = new WeakMap<object, { entries: unknown[]; isKeyValue: boolean }>();

const previewEntries = (value: object): { entries: unknown[]; isKeyValue: boolean } => {
  const cached = previewCache.get(value);
  if (cached !== undefined) return cached;
  const entries: unknown[] = [];
  let isKeyValue = false;
  for (const entry of value as unknown as Iterable<unknown>) {
    if (Array.isArray(entry)) {
      isKeyValue = true;
      entries.push(entry[0], entry[1]);
    } else {
      entries.push(entry);
    }
  }
  const snapshot = { entries, isKeyValue };
  previewCache.set(value, snapshot);
  return snapshot;
};

/** Node's `getIteratorBraces`. */
const getIteratorBraces = (type: string, tag: string): [string, string] => {
  if (tag !== `${type} Iterator`) {
    if (tag !== "") tag += "] [";
    tag += `${type} Iterator`;
  }
  return [`[${tag}] {`, "}"];
};

/** Node's `formatSetIterInner`. */
const formatSetIterInner = (
  ctx: Ctx,
  recurseTimes: number,
  entries: unknown[],
): string[] => {
  const maxArrayLength = Math.max(ctx.maxArrayLength, 0);
  const maxLength = Math.min(maxArrayLength, entries.length);
  const output: string[] = [];
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    output.push(formatValue(ctx, entries[i], recurseTimes));
  }
  ctx.indentationLvl -= 2;
  const remaining = entries.length - maxLength;
  if (remaining > 0) output.push(REMAINING_TEXT(remaining));
  return output;
};

/** Node's `formatMapIterInner`. */
const formatMapIterInner = (
  ctx: Ctx,
  recurseTimes: number,
  entries: unknown[],
): string[] => {
  const maxArrayLength = Math.max(ctx.maxArrayLength, 0);
  const len = entries.length / 2;
  const remaining = len - maxArrayLength;
  const maxLength = Math.min(maxArrayLength, len);
  const output: string[] = [];
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    const pos = i * 2;
    const res = [
      formatValue(ctx, entries[pos], recurseTimes),
      formatValue(ctx, entries[pos + 1], recurseTimes),
    ];
    output.push(
      reduceToSingleString(ctx, res, "", ["[", "]"], _K_ARRAY_EXTRAS_TYPE, recurseTimes),
    );
  }
  ctx.indentationLvl -= 2;
  if (remaining > 0) output.push(REMAINING_TEXT(remaining));
  return output;
};

/**
 * Node's `formatIterator` — renders a Map/Set iterator. An entries iterator
 * is labelled `Entries` rather than `Iterator`.
 */
const formatIterator = (
  braces: [string, string],
  ctx: Ctx,
  value: unknown,
  recurseTimes: number,
): string[] => {
  const { entries, isKeyValue } = previewEntries(value as object);
  if (isKeyValue) {
    braces[0] = braces[0].replace(/ Iterator] {$/, " Entries] {");
    return formatMapIterInner(ctx, recurseTimes, entries);
  }
  return formatSetIterInner(ctx, recurseTimes, entries);
};

const formatPromise = (ctx: Ctx, value: Promise<unknown>, recurseTimes: number): string[] => {
  ctx.indentationLvl += 2;
  const str = formatValue(ctx, "<pending>", recurseTimes);
  ctx.indentationLvl -= 2;
  return [str];
};

/** Node's `getFunctionBase`. */
const getFunctionBase = (value: Function, constructor: string | null, tag: string): string => {
  const stringified = Function.prototype.toString.call(value);
  if (stringified.startsWith("class") && stringified.endsWith("}")) {
    const slice = stringified.slice(5, -1);
    const bracketIndex = slice.indexOf("{");
    if (bracketIndex !== -1 && !slice.slice(0, bracketIndex).includes("(")) {
      return getClassBase(value, constructor, tag);
    }
  }
  // The intrinsic type follows the function's *own* source text (Node uses
  // `isGeneratorFunction`/`isAsyncFunction`, which inspect the source, not the
  // `constructor` property). The `constructor` reported by the prototype walk
  // can differ when the function was given another function's prototype (Node
  // renders both, e.g. `[GeneratorFunction (anonymous)] AsyncFunction`).
  let type = "Function";
  if (stringified.startsWith("async function*")) type = "AsyncGeneratorFunction";
  else if (stringified.startsWith("async ")) type = "AsyncFunction";
  else if (stringified.startsWith("function*")) type = "GeneratorFunction";
  let base = `[${type}`;
  if (constructor === null) base += " (null prototype)";
  const functionName = value.name;
  if (typeof functionName !== "string") base += `: ${String(functionName)}`;
  else if (functionName === "") base += " (anonymous)";
  else base += `: ${functionName}`;
  base += "]";
  if (constructor !== type && constructor !== null) base += ` ${constructor}`;
  if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
  return base;
};

const getClassBase = (value: Function, constructor: string | null, tag: string): string => {
  const hasName = Object.prototype.hasOwnProperty.call(value, "name");
  const name = (hasName && value.name) || "(anonymous)";
  let base = `class ${name}`;
  if (constructor !== "Function" && constructor !== null) base += ` [${constructor}]`;
  if (tag !== "" && constructor !== tag) base += ` [${tag}]`;
  if (constructor !== null) {
    const superName = Object.getPrototypeOf(value)?.name;
    if (superName) base += ` extends ${superName}`;
  } else {
    base += " extends [null prototype]";
  }
  return `[${base}]`;
};

const identicalSequenceRange = (a: string[], b: string[]): { len: number; offset: number } => {
  for (let i = 0; i < a.length - 3; i++) {
    const pos = b.indexOf(a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = Math.min(a.length - i, rest);
        while (maxLen > len && a[i + len] === b[pos + len]) len++;
        if (len > 3) return { len, offset: i };
      }
    }
  }
  return { len: 0, offset: 0 };
};

const getStackString = (error: Error): string =>
  error.stack ? String(error.stack) : error.toString();

/** Node's `improveStack` — prefixes the name onto bare stack strings. */
const improveStack = (
  stack: string,
  constructor: string | null,
  name: string,
  tag: string,
): string => {
  let len = name.length;
  if (
    constructor === null ||
    (name.endsWith("Error") &&
      stack.startsWith(name) &&
      (stack.length === len || stack[len] === ":" || stack[len] === "\n"))
  ) {
    let fallback = "Error";
    if (constructor === null) {
      const start =
        /^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/.exec(stack) ||
        /^([a-z_A-Z0-9-]*Error)$/.exec(stack);
      fallback = (start && start[1]) || "";
      len = fallback.length;
      fallback = fallback || "Error";
    }
    const prefix = getPrefix(constructor, tag, fallback).slice(0, -1);
    if (name !== prefix) {
      if (prefix.includes(name)) {
        if (len === 0) stack = `${prefix}: ${stack}`;
        else stack = `${prefix}${stack.slice(len)}`;
      } else {
        stack = `${prefix} [${name}]${stack.slice(len)}`;
      }
    }
  }
  return stack;
};

const removeDuplicateErrorKeys = (
  ctx: Ctx,
  keys: (string | symbol)[],
  err: Error,
  stack: string,
): void => {
  if (!ctx.showHidden && keys.length !== 0) {
    for (const name of ["name", "message", "stack"]) {
      const index = keys.indexOf(name);
      // Only hide the property in case it's part of the original stack
      if (index !== -1 && stack.includes((err as unknown as Record<string, string>)[name])) {
        keys.splice(index, 1);
      }
    }
  }
};

const getStackFrames = (ctx: Ctx, err: Error, stack: string): string[] => {
  const frames = stack.split("\n");
  let cause: unknown;
  try {
    ({ cause } = err as Error & { cause?: unknown });
  } catch {
    // If 'cause' is a getter that throws, ignore it.
  }
  if (cause != null && isError(cause)) {
    const causeStack = getStackString(cause);
    const causeStackStart = causeStack.indexOf("\n    at");
    if (causeStackStart !== -1) {
      const causeFrames = causeStack.slice(causeStackStart + 1).split("\n");
      const { len, offset } = identicalSequenceRange(frames, causeFrames);
      if (len > 0) {
        const skipped = len - 2;
        const msg = `    ... ${skipped} lines matching cause stack trace ...`;
        frames.splice(offset + 1, skipped, ctx.stylize(msg, "undefined"));
      }
    }
  }
  return frames;
};

/** Node's `formatError` — renders errors via their stack. */
const formatError = (
  err: Error,
  constructor: string | null,
  tag: string,
  ctx: Ctx,
  keys: (string | symbol)[],
): string => {
  const name = err.name != null ? String(err.name) : "Error";
  let stack = getStackString(err);
  removeDuplicateErrorKeys(ctx, keys, err, stack);
  if ("cause" in err && (keys.length === 0 || !keys.includes("cause"))) keys.push("cause");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (Array.isArray((err as any).errors) && (keys.length === 0 || !keys.includes("errors")))
    keys.push("errors");
  stack = improveStack(stack, constructor, name, tag);
  const message = err.message;
  let pos = (message && stack.indexOf(message)) || -1;
  if (pos !== -1) pos += message.length;
  const stackStart = stack.indexOf("\n    at", pos);
  if (stackStart === -1) {
    stack = `[${stack}]`;
  } else {
    let newStack = stack.slice(0, stackStart);
    const stackFramePart = stack.slice(stackStart + 1);
    const lines = getStackFrames(ctx, err, stackFramePart);
    newStack += `\n${lines.join("\n")}`;
    stack = newStack;
  }
  if (ctx.indentationLvl !== 0) {
    const indentation = " ".repeat(ctx.indentationLvl);
    stack = stack.replaceAll("\n", `\n${indentation}`);
  }
  return stack;
};

const getBoxedBase = (
  value: object,
  ctx: Ctx,
  keys: (string | symbol)[],
  constructor: string | null,
  tag: string,
): string => {
  // Brand-check via the toString tag rather than `instanceof`, so
  // cross-realm boxed primitives are detected. `fn.call(value)` would
  // throw for foreign-realm wrappers, so invoke the prototype method
  // with an explicit receiver via Function.prototype.call.
  const callWithValue = (fn: (this: unknown) => unknown): unknown =>
    Function.prototype.call.call(fn, value);
  let fn: () => unknown;
  let type: string;
  if (hasInternalSlot(value, Number.prototype.valueOf)) {
    fn = () => callWithValue(Number.prototype.valueOf);
    type = "Number";
  } else if (hasInternalSlot(value, String.prototype.valueOf)) {
    fn = () => callWithValue(String.prototype.valueOf);
    type = "String";
    keys.splice(0, (value as unknown as { length: number }).length);
  } else if (hasInternalSlot(value, Boolean.prototype.valueOf)) {
    fn = () => callWithValue(Boolean.prototype.valueOf);
    type = "Boolean";
  } else if (typeof BigInt === "function" && hasInternalSlot(value, BigInt.prototype.valueOf)) {
    fn = () => callWithValue(BigInt.prototype.valueOf);
    type = "BigInt";
  } else {
    fn = () => callWithValue(Symbol.prototype.valueOf);
    type = "Symbol";
  }
  let base = `[${type}`;
  if (type !== constructor) {
    if (constructor === null) base += " (null prototype)";
    else base += ` (${constructor})`;
  }
  base += `: ${formatPrimitive(stylizeNoColor, fn(), ctx)}]`;
  if (tag !== "" && tag !== constructor) base += ` [${tag}]`;
  if (keys.length !== 0 || ctx.stylize === stylizeNoColor) return base;
  return ctx.stylize(base, type.toLowerCase());
};

/**
 * Node's `formatProperty` — renders one `key: value` entry, handling
 * getters/setters, symbol keys, non-enumerables and `__proto__`.
 */
const formatProperty = (
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  recurseTimes: number,
  key: string | symbol,
  type: number,
  desc?: PropertyDescriptor,
  original?: unknown,
): string => {
  let name: string;
  let str: string;
  let extra = " ";
  desc =
    desc ||
    Object.getOwnPropertyDescriptor(value, key) ||
    ({ value: value[key], enumerable: true } as PropertyDescriptor);
  if (desc.value !== undefined) {
    // With `compact: true` a value wider than the remaining break length
    // moves onto its own indented line (Node's `extra` newline).
    const diff = (ctx.compact !== true || type !== K_OBJECT_TYPE) ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes);
    if (diff === 3 && ctx.breakLength < removeColors(str).length) {
      extra = `\n${" ".repeat(ctx.indentationLvl)}`;
    }
    ctx.indentationLvl -= diff;
  } else if (desc.get !== undefined) {
    const label = desc.set !== undefined ? "Getter/Setter" : "Getter";
    const s = ctx.stylize;
    const sp = "special";
    if (
      ctx.getters &&
      (ctx.getters === true ||
        (ctx.getters === "get" && desc.set === undefined) ||
        (ctx.getters === "set" && desc.set !== undefined))
    ) {
      try {
        const tmp = desc.get.call(original ?? value);
        ctx.indentationLvl += 2;
        if (tmp === null) {
          str = `${s(`[${label}:`, sp)} ${s("null", "null")}${s("]", sp)}`;
        } else if (typeof tmp === "object") {
          str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
        } else {
          const primitive = formatPrimitive(s, tmp, ctx);
          str = `${s(`[${label}:`, sp)} ${primitive}${s("]", sp)}`;
        }
        ctx.indentationLvl -= 2;
      } catch (err) {
        const message = `<Inspection threw (${(err as Error).message})>`;
        str = `${s(`[${label}:`, sp)} ${message}${s("]", sp)}`;
      }
    } else {
      str = ctx.stylize(`[${label}]`, sp);
    }
  } else if (desc.set !== undefined) {
    str = ctx.stylize("[Setter]", "special");
  } else {
    str = ctx.stylize("undefined", "undefined");
  }
  if (type === K_ARRAY_TYPE) return str;
  if (typeof key === "symbol") {
    const tmp = String(key).replace(STR_ESCAPE_SEQUENCES_G, escapeFn);
    name = `[${ctx.stylize(tmp, "symbol")}]`;
  } else if (key === "__proto__") {
    name = "['__proto__']";
  } else if (desc.enumerable === false) {
    name = `[${key.replace(STR_ESCAPE_SEQUENCES_G, escapeFn)}]`;
  } else if (KEY_STR_RE.test(key)) {
    name = ctx.stylize(key, "name");
  } else {
    name = ctx.stylize(strEscape(key), "string");
  }
  return `${name}:${extra}${str}`;
};

const isBelowBreakLength = (ctx: Ctx, output: string[], start: number, base: string): boolean => {
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength) return false;
  for (let i = 0; i < output.length; i++) {
    totalLength += ctx.colors ? removeColors(output[i]).length : output[i].length;
    if (totalLength > ctx.breakLength) return false;
  }
  return base === "" || !base.includes("\n");
};

const join = (arr: string[], sep: string): string => arr.join(sep);

/**
 * Node's `groupArrayElements` — packs short array entries into columns so a
 * long array of numbers does not take one line per element.
 */
const groupArrayElements = (ctx: Ctx, output: string[], value?: unknown): string[] => {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (ctx.maxArrayLength < output.length) {
    // This makes sure the "... n more items" part is not taken into account.
    outputLength--;
  }
  const separatorSpace = 2; // Add 1 for the space and 1 for the separator.
  const dataLen = new Array<number>(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const len = removeColors(output[i]).length;
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  // Add two to `maxLength` as we add a single whitespace character plus a comma
  // in-between two entries.
  const actualMax = maxLength + separatorSpace;
  // Check if at least three entries fit next to each other and prevent grouping
  // of arrays that contains entries of very different length.
  if (
    actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
    (totalLength / actualMax > 5 || maxLength <= 6)
  ) {
    const approxCharHeights = 2.5;
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    // Dynamically check how many columns seem possible.
    const columns = Math.min(
      Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      ctx.compact * 4,
      15,
    );
    if (columns <= 1) return output;
    const tmp: string[] = [];
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength) lineMaxLength = dataLen[j];
      }
      lineMaxLength += separatorSpace;
      maxLineLength[i] = lineMaxLength;
    }
    // Numbers are right-aligned, everything else is left-aligned.
    let padStart = true;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        const element = (value as { [index: number]: unknown })[i];
        if (typeof element !== "number" && typeof element !== "bigint") {
          padStart = false;
          break;
        }
      }
    }
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let str = "";
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        // Node pads the entry *including* its trailing ", ".
        str += padStart
          ? `${output[j]}, `.padStart(padding, " ")
          : `${output[j]}, `.padEnd(padding, " ");
      }
      if (padStart) {
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
        str += output[j].padStart(padding, " ");
      } else {
        str += output[j];
      }
      tmp.push(str);
    }
    if (ctx.maxArrayLength < output.length) {
      tmp.push(output[outputLength]);
    }
    return tmp;
  }
  return output;
};

const reduceToSingleString = (
  ctx: Ctx,
  output: string[],
  base: string,
  braces: [string, string],
  extrasType: number,
  recurseTimes: number,
  value?: unknown,
): string => {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === "number" && ctx.compact >= 1) {
      // Memorize the original output length. In case the output is grouped,
      // prevent lining up the entries on a single line.
      const entries = output.length;
      // Group array elements together if the array contains at least six
      // separate entries.
      if (extrasType === _K_ARRAY_EXTRAS_TYPE && entries > 6) {
        output = groupArrayElements(ctx, output, value);
      }
      if (ctx.currentDepth - recurseTimes < ctx.compact && entries === output.length) {
        const start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joinedOutput = join(output, ", ");
          if (!joinedOutput.includes("\n")) {
            return `${base ? `${base} ` : ""}${braces[0]} ${joinedOutput} ${braces[1]}`;
          }
        }
      }
    }
    const indentation = `\n${" ".repeat(ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ""}${braces[0]}${indentation}  ${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // `compact: true` — every entry on one line while it fits `breakLength`.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ""} ${join(output, ", ")} ${braces[1]}`;
  }
  const indentation = " ".repeat(ctx.indentationLvl);
  const ln =
    base === "" && braces[0].length === 1 ? " " : `${base ? ` ${base}` : ""}\n${indentation}  `;
  return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
};

const handleMaxCallStackSize = (
  ctx: Ctx,
  err: unknown,
  constructorName: string,
  indentationLvl: number,
): string => {
  if ((err as Error)?.message?.includes("Maximum call stack size exceeded")) {
    ctx.seen.pop();
    ctx.indentationLvl = indentationLvl;
    return ctx.stylize(
      `[${constructorName}: Inspection interrupted prematurely. Maximum call stack size exceeded.]`,
      "special",
    );
  }
  throw err;
};

/** Node's `formatRaw` — the main object/array/function formatting dispatch. */
const formatRaw = (
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  recurseTimes: number,
  typedArray?: boolean,
): string => {
  let keys: (string | symbol)[] = [];
  let protoProps: string[] | undefined;
  if (ctx.showHidden && (recurseTimes <= (ctx.depth ?? Infinity) || ctx.depth === null)) {
    protoProps = [];
  }

  const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
  if (protoProps !== undefined && protoProps.length === 0) protoProps = undefined;

  let tag = value[Symbol.toStringTag];
  if (
    typeof tag !== "string" ||
    (tag !== "" &&
      (ctx.showHidden
        ? Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
        : Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag)))
  ) {
    tag = "";
  }
  let base = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let formatter: ((ctx: Ctx, value: any, recurseTimes: number) => string[]) | undefined;
  let braces: [string, string] = ["{", "}"];
  let noIterator = true;
  let i = 0;
  let extrasType = K_OBJECT_TYPE;

  if (Symbol.iterator in value || constructor === null) {
    noIterator = false;
    if (Array.isArray(value)) {
      const prefix =
        constructor !== "Array" || tag !== ""
          ? getPrefix(constructor, tag, "Array", `(${value.length})`)
          : "";
      keys = getOwnNonIndexProperties(value, ctx.showHidden);
      braces = [`${prefix}[`, "]"];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined)
        return `${braces[0]}]`;
      formatter = formatArray;
      extrasType = _K_ARRAY_EXTRAS_TYPE;
    } else if (isSet(value)) {
      const size = setBrandSafe.size(value);
      const prefix = getPrefix(constructor, tag, "Set", `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = formatSet.bind(null, value);
      if (size === 0 && keys.length === 0 && protoProps === undefined) return `${prefix}{}`;
      braces = [`${prefix}{`, "}"];
    } else if (isMap(value)) {
      const size = mapBrandSafe.size(value);
      const prefix = getPrefix(constructor, tag, "Map", `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = formatMap.bind(null, value);
      if (size === 0 && keys.length === 0 && protoProps === undefined) return `${prefix}{}`;
      braces = [`${prefix}{`, "}"];
    } else if (isMapIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces("Map", tag);
      formatter = formatIterator.bind(null, braces) as typeof formatter;
    } else if (isSetIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces("Set", tag);
      formatter = formatIterator.bind(null, braces) as typeof formatter;
    } else if (ArrayBuffer.isView(value) && !isDataView(value)) {
      keys = getOwnNonIndexProperties(value, ctx.showHidden);
      // The `length` of a TypedArray can be redefined; the real element count
      // is the view's byteLength over the element size. A null-prototype
      // view exposes neither, so read the V8 internal slots instead.
      const rawLength = typedArrayBrandSafe.length(value);
      const elementSize = typedArrayBrandSafe.bytesPerElement(value);
      const buffer = typedArrayBrandSafe.buffer(value);
      const byteOffset = typedArrayBrandSafe.byteOffset(value);
      const byteLength = buffer === undefined ? 0 : buffer.byteLength - byteOffset;
      const size = rawLength >= 0 ? rawLength : byteLength / elementSize;
      const fallback = typedArrayBrandSafe.name(value);
      const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
      braces = [`${prefix}[`, "]"];
      if (size === 0 && keys.length === 0 && !ctx.showHidden) return `${braces[0]}]`;
      // Node reconstructs the view from its internal slots when the prototype
      // was dropped, so `formatTypedArray` sees a normal `length` and numeric
      // elements rather than a broken view.
      const bound =
        constructor === null
          ? new ((globalThis as Record<string, unknown>)[fallback] as new (
              v: unknown,
            ) => unknown[] & ArrayLike<unknown>)(value)
          : (value as unknown as unknown[] & ArrayLike<unknown>);
      formatter = formatTypedArray.bind(null, bound, size);
      extrasType = _K_ARRAY_EXTRAS_TYPE;
    } else {
      noIterator = true;
    }
  }
  if (noIterator) {
    if (
      constructor === null &&
      typeof value === "object" &&
      value.constructor === undefined &&
      !isBoxedPrimitive(value) &&
      !isRegExp(value) &&
      !isDate(value) &&
      !isError(value) &&
      !isMap(value) &&
      !isSet(value) &&
      !isWeakMap(value) &&
      !isWeakSet(value) &&
      !isPromise(value) &&
      !isAnyArrayBuffer(value) &&
      !isDataView(value) &&
      !ArrayBuffer.isView(value)
    ) {
      // Null-prototype object: Node renders it with the `[X: null prototype]`
      // prefix, where `X` is the constructor V8's creation map still remembers.
      // The recorder holds the name for objects that went through
      // `setPrototypeOf`; everything else was created null-proto, whose map
      // name is "Object". `Object.prototype.toString` must NOT be used: it
      // follows `Symbol.toStringTag`, which the creation-map name ignores.
      const fallback = nullPrototypeConstructorName(value) ?? "Object";
      const prefix = fallback === tag ? "Object" : fallback;
      braces = [`${getPrefix(null, tag, prefix)}{`, "}"];
      keys = getKeys(value, ctx.showHidden);
      if (keys.length === 0 && protoProps === undefined) return `${braces[0]}}`;
    } else {
      keys = getKeys(value, ctx.showHidden);
      braces = ["{", "}"];
      if (constructor === "Object") {
        if (isArgumentsObject(value)) {
          braces[0] = "[Arguments] {";
        } else if (tag !== "") {
          braces[0] = `${getPrefix(constructor, tag, "Object")}{`;
        }
        if (keys.length === 0 && protoProps === undefined) return `${braces[0]}}`;
      } else if (typeof value === "function") {
        base = getFunctionBase(value, constructor, tag);
        if (keys.length === 0 && protoProps === undefined) return ctx.stylize(base, "special");
      } else if (isRegExp(value)) {
        // `RegExp.prototype.toString` reads `source`/`flags` through the
        // prototype chain, so a null-prototype regexp renders as
        // `/undefined/undefined`. Read the internal slots directly instead
        // (Node's `RegExpPrototypeToString` sees the slots, not the chain).
        const sourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")
          ?.get as (() => string) | undefined;
        // `RegExp.prototype.flags` reads `this.global` etc. through the
        // prototype chain, which a null-prototype regexp no longer has. The
        // individual flag getters read V8's internal slots, so use those.
        const flagGetters = (
          [
            ["hasIndices", "d"],
            ["global", "g"],
            ["ignoreCase", "i"],
            ["multiline", "m"],
            ["dotAll", "s"],
            ["unicode", "u"],
            ["unicodeSets", "v"],
            ["sticky", "y"],
          ] as const
        ).map(
          ([name]) =>
            Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get as
              | (() => boolean)
              | undefined,
        );
        const flagsGetter = (): string => {
          let flags = "";
          for (let i = 0; i < flagGetters.length; i++) {
            if (flagGetters[i]?.call(value) === true) flags += FLAG_LETTERS[i];
          }
          return flags;
        };
        base = (() => {
          // Never read `value.toString` directly: a test can define a
          // throwing getter there. Look the property up safely instead.
          const toStringDescriptor = Object.getOwnPropertyDescriptor(value, "toString");
          const ownToString =
            toStringDescriptor !== undefined
              ? toStringDescriptor.value
              : Object.getPrototypeOf(value) === RegExp.prototype
                ? RegExp.prototype.toString
                : undefined;
          return typeof ownToString === "function" && constructor !== null
            ? Function.prototype.call.call(ownToString, value)
            : `/${sourceGetter?.call(value) ?? ""}/${flagsGetter?.call(value) ?? ""}`;
        })();
        const prefix = getPrefix(constructor, tag, "RegExp");
        if (prefix !== "RegExp ") base = `${prefix}${base}`;
        if (
          (keys.length === 0 && protoProps === undefined) ||
          (recurseTimes > (ctx.depth ?? Infinity) && ctx.depth !== null)
        ) {
          return ctx.stylize(base, "regexp");
        }
      } else if (isDate(value)) {
        // `{ __proto__: Date.prototype }` looks like a Date but has no
        // internal slot; the generic methods throw on it. `getTime` is a
        // brand check, so a successful call proves the slot.
        let realDate = true;
        let time = Number.NaN;
        try {
          time = Date.prototype.getTime.call(value);
        } catch {
          realDate = false;
        }
        if (!realDate) {
          // `{ __proto__: Date.prototype }` — Node renders just `Date {}`.
          return "Date {}";
        }
        base = Number.isNaN(time)
          ? Date.prototype.toString.call(value)
          : Date.prototype.toISOString.call(value);
        const prefix = getPrefix(constructor, tag, "Date");
        if (prefix !== "Date ") base = `${prefix}${base}`;
        if (keys.length === 0 && protoProps === undefined) return ctx.stylize(base, "date");
      } else if (isError(value)) {
        base = formatError(value, constructor, tag, ctx, keys);
        if (keys.length === 0 && protoProps === undefined) return base;
      } else if (isAnyArrayBuffer(value)) {
        const arrayType = isArrayBuffer(value) ? "ArrayBuffer" : "SharedArrayBuffer";
        const prefix = getPrefix(constructor, tag, arrayType);
        if (typedArray === undefined) {
          formatter = formatArrayBuffer;
          braces[0] = `${prefix}{`;
          // The bytes come first, `byteLength` last.
          keys.unshift("byteLength");
        } else if (keys.length === 0 && protoProps === undefined) {
          return prefix + `{ byteLength: ${formatNumber(ctx.stylize, value.byteLength, false)} }`;
        } else {
          braces[0] = `${prefix}{`;
          keys.unshift("byteLength");
        }
      } else if (isDataView(value)) {
        braces[0] = `${getPrefix(constructor, tag, "DataView")}{`;
        keys.unshift("byteLength", "byteOffset", "buffer");
      } else if (isPromise(value)) {
        braces[0] = `${getPrefix(constructor, tag, "Promise")}{`;
        formatter = formatPromise;
      } else if (isWeakSet(value)) {
        braces[0] = `${getPrefix(constructor, tag, "WeakSet")}{`;
        formatter = formatWeakCollection as typeof formatter;
      } else if (isWeakMap(value)) {
        braces[0] = `${getPrefix(constructor, tag, "WeakMap")}{`;
        formatter = formatWeakCollection as typeof formatter;
      } else if (isBoxedPrimitive(value)) {
        base = getBoxedBase(value, ctx, keys, constructor, tag);
        if (keys.length === 0 && protoProps === undefined) return base;
      } else {
        if (keys.length === 0 && protoProps === undefined) {
          return `${CtxStyle(value, constructor, tag)}{}`;
        }
        braces[0] = `${CtxStyle(value, constructor, tag)}{`;
      }
    }
  }

  if (recurseTimes > (ctx.depth ?? Infinity) && ctx.depth !== null) {
    let constructorName = CtxStyle(value, constructor, tag).slice(0, -1);
    if (constructor !== null) constructorName = `[${constructorName}]`;
    return ctx.stylize(constructorName, "special");
  }
  recurseTimes += 1;

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output: string[];
  const indentationLvl = ctx.indentationLvl;
  try {
    output = formatter ? formatter(ctx, value, recurseTimes) : [];
    for (i = 0; i < keys.length; i++) {
      output.push(formatProperty(ctx, value, recurseTimes, keys[i], extrasType));
    }
    if (protoProps !== undefined) output.push(...protoProps);
  } catch (err) {
    const constructorName = CtxStyle(value, constructor, tag).slice(0, -1);
    return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
  }
  if (ctx.circular !== undefined) {
    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = ctx.stylize(`<ref *${index}>`, "special");
      if (ctx.compact !== true) {
        base = base === "" ? reference : `${reference} ${base}`;
      } else {
        braces[0] = `${reference} ${braces[0]}`;
      }
    }
  }
  ctx.seen.pop();

  if (ctx.sorted) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === K_OBJECT_TYPE) {
      output.sort(comparator);
    } else if (keys.length > 1) {
      const sorted = output.slice(output.length - keys.length).sort(comparator as never);
      output.splice(output.length - keys.length, keys.length, ...sorted);
    }
  }

  return reduceToSingleString(ctx, output, base, braces, extrasType, recurseTimes, value);
};

/** Node's `formatValue`. */
const formatValue = (
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  recurseTimes: number,
  typedArray?: boolean,
): string => {
  if (
    typeof value !== "object" &&
    typeof value !== "function" &&
    !UNDETECTABLE(value) &&
    value !== null
  ) {
    return formatPrimitive(ctx.stylize, value, ctx);
  }
  if (value === null) return ctx.stylize("null", "null");

  if (ctx.customInspect) {
    const maybeCustom = value[customInspectSymbol];
    if (
      typeof maybeCustom === "function" &&
      // Filter out any prototype objects using the circular check. Unlike
      // Node we do NOT filter the util module's own `inspect` function: it is
      // a plain function here, so `{ [inspect.custom]: inspect }` renders it
      // as `[Function (anonymous)]` — Node renders `[Function: inspect]`.
      maybeCustom !== inspect &&
      !(value.constructor && value.constructor.prototype === value)
    ) {
      const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
      let ret: unknown;
      try {
        ret = maybeCustom.call(value, depth, getUserOptions(ctx), inspect);
      } catch {
        ret = undefined;
      }
      if (ret !== value) {
        if (typeof ret !== "string") return formatValue(ctx, ret, recurseTimes);
        return ret.replaceAll("\n", `\n${" ".repeat(ctx.indentationLvl)}`);
      }
    }
  }

  if (ctx.seen.includes(value)) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new Map();
      ctx.circular.set(value, index);
    } else {
      index = ctx.circular.get(value) ?? ctx.circular.size + 1;
      ctx.circular.set(value, index);
    }
    return ctx.stylize(`[Circular *${index}]`, "special");
  }

  return formatRaw(ctx, value, recurseTimes, typedArray);
};

const getUserOptions = (ctx: Ctx): InspectOptions => ({
  stylize: ctx.stylize,
  showHidden: ctx.showHidden,
  depth: ctx.depth ?? undefined,
  colors: ctx.colors,
  customInspect: ctx.customInspect,
  showProxy: ctx.showProxy,
  maxArrayLength: ctx.maxArrayLength,
  maxStringLength: ctx.maxStringLength,
  breakLength: ctx.breakLength,
  compact: ctx.compact,
  sorted: ctx.sorted,
  getters: ctx.getters,
  numericSeparator: ctx.numericSeparator,
  // Node passes the raw user options through, so unknown keys (e.g.
  // `customInspectOptions`) reach a custom inspect function untouched.
  ...ctx.userOptions,
});

/**
 * Node-compatible `util.inspect` (lib/internal/util/inspect.js port).
 */
const inspectFn = function inspect(
  value: unknown,
  opts?: InspectOptions | boolean,
  // Legacy signature: inspect(value, showHidden, depth, colors).
  legacyDepth?: number,
  legacyColors?: boolean,
): string {
    const ctx: Ctx = {
      budget: {},
      indentationLvl: 0,
      seen: [],
      currentDepth: 0,
      stylize: stylizeNoColor,
      showHidden: inspectDefaultOptions.showHidden === true,
      depth: inspectDefaultOptions.depth === null
        ? null
        : (inspectDefaultOptions.depth ?? 2),
      colors: inspectDefaultOptions.colors === true,
      customInspect: inspectDefaultOptions.customInspect !== false,
      showProxy: inspectDefaultOptions.showProxy === true,
      maxArrayLength: inspectDefaultOptions.maxArrayLength === null
        ? null
        : (inspectDefaultOptions.maxArrayLength ?? 100),
      maxStringLength: inspectDefaultOptions.maxStringLength === null
        ? null
        : (inspectDefaultOptions.maxStringLength ?? 10000),
      breakLength: inspectDefaultOptions.breakLength ?? 80,
      compact: inspectDefaultOptions.compact ?? 3,
      sorted: inspectDefaultOptions.sorted === true,
      getters: inspectDefaultOptions.getters ?? false,
      numericSeparator: inspectDefaultOptions.numericSeparator === true,
    };
    if (legacyDepth !== undefined) ctx.depth = legacyDepth;
    if (legacyColors !== undefined) ctx.colors = legacyColors;
    if (typeof opts === "boolean") {
      ctx.showHidden = opts;
    } else if (opts) {
      const optKeys = Object.keys(opts) as (keyof InspectOptions)[];
      for (const key of optKeys) {
        if (key in inspectDefaultOptions || key === "stylize") {
          (ctx as unknown as Record<string, unknown>)[key] = opts[key];
        } else if (ctx.userOptions === undefined) {
          // This is required to pass through the actual user input.
          ctx.userOptions = opts as Record<string, unknown>;
        }
      }
    }
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
};

export const inspect = Object.assign(inspectFn, {
  custom: customInspectSymbol,
  colors: COLORS,
  styles: STYLES,
});

/**
 * Node defines `inspect.defaultOptions` as an accessor: reading it returns
 * the live defaults object, writing it validates the argument and merges it
 * into the defaults rather than replacing them.
 */
Object.defineProperty(inspect, "defaultOptions", {
  __proto__: null,
  get: () => inspectDefaultOptions,
  set: (options: unknown) => {
    if (options === null || typeof options !== "object") {
      const received =
        options === null
          ? "null"
          : `type ${typeof options} (${
              typeof options === "string" ? `'${options}'` : String(options)
            })`;
      throw Object.assign(
        new TypeError(`The "options" argument must be of type object. Received ${received}`),
        { code: "ERR_INVALID_ARG_TYPE" },
      );
    }
    Object.assign(inspectDefaultOptions, options);
  },
});

// ---------------------------------------------------------------------------
// format / formatWithOptions (lib/internal/util/inspect.js)
// ---------------------------------------------------------------------------

const firstErrorLine = (error: Error): string => error.message.split("\n", 1)[0];
let CIRCULAR_ERROR_MESSAGE: string | undefined;

const tryStringify = (arg: unknown): string => {
  try {
    return JSON.stringify(arg) as string;
  } catch (err) {
    if (!CIRCULAR_ERROR_MESSAGE) {
      try {
        const a: Record<string, unknown> = {};
        a.a = a;
        JSON.stringify(a);
      } catch (circularError) {
        CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError as Error);
      }
    }
    if (
      (err as Error).name === "TypeError" &&
      firstErrorLine(err as Error) === CIRCULAR_ERROR_MESSAGE
    ) {
      return "[Circular]";
    }
    throw err;
  }
};

/** Node's `hasBuiltInToString` — does the value stringify via a built-in? */
const hasBuiltInToString = (value: unknown): boolean => {
  // Count objects without a `toString`/`Symbol.toPrimitive` function as
  // built-in; a value that owns one of them is never built-in.
  const toString = (value as { toString?: unknown }).toString;
  const toPrimitive = (value as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive];
  let hasOwnToString = Object.prototype.hasOwnProperty;
  let hasOwnToPrimitive = Object.prototype.hasOwnProperty;
  if (typeof toString !== "function") {
    if (typeof toPrimitive !== "function") return true;
    if (Object.prototype.hasOwnProperty.call(value, Symbol.toPrimitive)) return false;
    hasOwnToString = () => false;
  } else if (Object.prototype.hasOwnProperty.call(value, "toString")) {
    return false;
  } else if (typeof toPrimitive !== "function") {
    hasOwnToPrimitive = () => false;
  } else if (Object.prototype.hasOwnProperty.call(value, Symbol.toPrimitive)) {
    return false;
  }
  // Find the object that owns `toString` or `Symbol.toPrimitive`.
  let pointer = value;
  do {
    pointer = Object.getPrototypeOf(pointer);
  } while (
    pointer !== null &&
    !hasOwnToString.call(pointer, "toString") &&
    !hasOwnToPrimitive.call(pointer, Symbol.toPrimitive)
  );
  if (pointer === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(pointer, "constructor");
  return (
    descriptor !== undefined &&
    typeof descriptor.value === "function" &&
    BUILT_IN_OBJECTS.has(descriptor.value.name)
  );
};

const formatNumberNoColor = (number: number, options?: InspectOptions): string =>
  formatNumber(
    stylizeNoColor,
    number,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator === true,
  );

const formatBigIntNoColor = (bigint: bigint, options?: InspectOptions): string =>
  formatBigInt(
    stylizeNoColor,
    bigint,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator === true,
  );

const formatWithOptionsInternal = (
  inspectOptions: InspectOptions | undefined,
  args: unknown[],
): string => {
  const first = args[0];
  let a = 0;
  let str = "";
  let join = "";

  if (typeof first === "string") {
    if (args.length === 1) return first;
    let tempStr: string | undefined;
    let lastPos = 0;

    for (let i = 0; i < first.length - 1; i++) {
      if (first.charCodeAt(i) === 37) {
        const nextChar = first.charCodeAt(++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: {
              const tempArg = args[++a];
              if (typeof tempArg === "number") {
                tempStr = formatNumberNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg === "bigint") {
                tempStr = formatBigIntNoColor(tempArg, inspectOptions);
              } else if (
                typeof tempArg !== "object" ||
                tempArg === null ||
                !hasBuiltInToString(tempArg)
              ) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...inspectOptions,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106:
              tempStr = tryStringify(args[++a]);
              break;
            case 100: {
              const tempNum = args[++a];
              if (typeof tempNum === "bigint") {
                tempStr = formatBigIntNoColor(tempNum, inspectOptions);
              } else if (typeof tempNum === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(Number(tempNum), inspectOptions);
              }
              break;
            }
            case 79:
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111:
              tempStr = inspect(args[++a], {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: {
              const tempInteger = args[++a];
              if (typeof tempInteger === "bigint") {
                tempStr = formatBigIntNoColor(tempInteger, inspectOptions);
              } else if (typeof tempInteger === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(
                  Number.parseInt(tempInteger as string),
                  inspectOptions,
                );
              }
              break;
            }
            case 102: {
              const tempFloat = args[++a];
              if (typeof tempFloat === "symbol") {
                tempStr = "NaN";
              } else {
                tempStr = formatNumberNoColor(
                  Number.parseFloat(tempFloat as string),
                  inspectOptions,
                );
              }
              break;
            }
            case 99:
              a += 1;
              tempStr = "";
              break;
            case 37:
              str += first.slice(lastPos, i);
              lastPos = i + 1;
              continue;
            default:
              continue;
          }
          if (lastPos !== i - 1) {
            str += first.slice(lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = " ";
      if (lastPos < first.length) {
        str += first.slice(lastPos);
      }
    }
  }

  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== "string" ? inspect(value, inspectOptions) : value;
    join = " ";
    a++;
  }
  return str;
};

/**
 * `util.format` — Node's formatWithOptionsInternal semantics: `%s` via
 * hasBuiltInToString, `%d` via Number(), `%i` via parseInt (no radix),
 * `%f` via parseFloat, `%o` inspects with showHidden/showProxy/depth:4,
 * `%c` consumes an argument, leftover args are inspected and appended.
 */
export const format = (...args: unknown[]): string => formatWithOptionsInternal(undefined, args);

export const formatWithOptions = (inspectOptions: InspectOptions, ...args: unknown[]): string => {
  if (
    inspectOptions === null ||
    typeof inspectOptions !== "object" ||
    (typeof inspectOptions === "object" &&
      Array.isArray(inspectOptions) === false &&
      inspectOptions === undefined)
  ) {
    // fallthrough to validateObject below
  }
  if (inspectOptions === null || typeof inspectOptions !== "object") {
    throw Object.assign(
      new TypeError(
        `The "inspectOptions" argument must be of type object. Received ${String(inspectOptions)}`,
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  return formatWithOptionsInternal(inspectOptions, args);
};
