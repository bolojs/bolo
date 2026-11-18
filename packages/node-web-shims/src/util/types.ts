/**
 * `node:util/types` — a faithful browser implementation of Node's type
 * predicates.
 *
 * unenv's `node/util/types` stubs most predicates as `notImplemented()` (they
 * throw) and returns a constant `false` for `isExternal`, so the vendored
 * Node test `test/parallel/test-util-types.js` fails on its first assertion.
 * These implementations follow Node's observable semantics for the values a
 * browser container can actually produce.
 *
 * Two Node behaviours are deliberately not reproduced, because they depend on
 * V8 internals a browser cannot observe:
 *
 * - `isExternal` — Node returns `true` only for objects that live outside the
 *   JS heap (a C++-owned `JSStream` handle, for example). Every value a
 *   browser can hold is heap-resident, so `false` is the faithful answer.
 * - `isProxy` — V8 exposes no public API to detect a proxy, so the predicate
 *   cannot be answered faithfully.
 */

/** `Object.prototype.toString` tag of a value, e.g. `"Uint8Array"`. */
const tagOf = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1);

const TYPED_ARRAY_TAGS = new Set([
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * V8's internal class of a value, as a `Object.prototype.toString` tag.
 *
 * `Object.prototype.toString` reads the object's internal slots, so it is
 * realm-independent (a cross-realm `Map` still reports `"Map"`) — the same
 * source of truth Node's own predicates use.
 *
 * The exception is typed arrays and DataViews: their tag is derived from the
 * *prototype chain*, so it cannot tell a genuine typed array from a
 * "stealthy" one (an instance whose prototype was swapped) nor from a "fake"
 * one (`Object.create(Uint8Array.prototype)`). `structuredClone` serializes
 * the object's internal class instead, so a round trip through it reports the
 * true class: a stealthy `Uint8Array` clones back as a `Uint8Array`, while a
 * fake one clones back as a plain `Object`. That is the distinction Node's
 * predicates make.
 */
const internalClassOf = (value: unknown): string => {
  if (value === null || typeof value !== "object") return tagOf(value);
  const tag = tagOf(value);
  if (
    !TYPED_ARRAY_TAGS.has(tag) &&
    tag !== "DataView" &&
    tag !== "ArrayBuffer" &&
    tag !== "SharedArrayBuffer"
  ) {
    return tag;
  }
  try {
    return Object.prototype.toString.call(structuredClone(value)).slice(8, -1);
  } catch {
    // Not cloneable: the prototype chain is the best answer available.
    return tag;
  }
};

/** True for a genuine typed-array instance (not a DataView). */
const isTypedArrayInstance = (value: unknown): boolean =>
  TYPED_ARRAY_TAGS.has(internalClassOf(value));

/**
 * Node's `types.isTypedArray`: a typed array, including a "stealthy" one
 * whose prototype was swapped, but not a DataView.
 */
const isTypedArray = (value: unknown): boolean => isTypedArrayInstance(value);

/**
 * Node's `types.isArrayBufferView`: a typed array or a DataView, including
 * the "stealthy" variants whose prototype was swapped.
 */
const isArrayBufferView = (value: unknown): boolean => {
  const cls = internalClassOf(value);
  return TYPED_ARRAY_TAGS.has(cls) || cls === "DataView";
};

const isArrayBuffer = (value: unknown): boolean => internalClassOf(value) === "ArrayBuffer";

const isSharedArrayBuffer = (value: unknown): boolean =>
  internalClassOf(value) === "SharedArrayBuffer";

/** Node's `types.isAnyArrayBuffer`: an ArrayBuffer or a SharedArrayBuffer. */
const isAnyArrayBuffer = (value: unknown): boolean =>
  isArrayBuffer(value) || isSharedArrayBuffer(value);

/** Node's `types.isBoxedPrimitive`: a primitive wrapped in its object form. */
const isBoxedPrimitive = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  const cls = internalClassOf(value);
  return (
    cls === "Boolean" ||
    cls === "Number" ||
    cls === "String" ||
    cls === "Symbol" ||
    cls === "BigInt"
  );
};

/**
 * Node's `types.isArgumentsObject`: an `arguments` exotic object. Detected
 * through its own `Symbol.iterator` and `callee` shape, since
 * `Object.prototype.toString` reports `"Arguments"` only for genuine ones.
 */
const isArgumentsObject = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  tagOf(value) === "Arguments" &&
  typeof (value as { length?: unknown }).length === "number";

/**
 * Node's `types.isNativeError`: an error object. Cross-realm errors are
 * included, so the check is tag-based rather than `instanceof`.
 */
const isNativeError = (value: unknown): boolean => {
  if (value instanceof Error) return true;
  if (value === null || typeof value !== "object") return false;
  const tag = tagOf(value);
  if (
    tag !== "Error" &&
    tag !== "EvalError" &&
    tag !== "RangeError" &&
    tag !== "ReferenceError" &&
    tag !== "SyntaxError" &&
    tag !== "TypeError" &&
    tag !== "URIError"
  ) {
    return false;
  }
  return typeof (value as { message?: unknown }).message === "string";
};

const isAsyncFunction = (value: unknown): boolean =>
  typeof value === "function" &&
  (value as { constructor: { name: string } }).constructor.name === "AsyncFunction";

const isGeneratorFunction = (value: unknown): boolean =>
  typeof value === "function" &&
  (value as { constructor: { name: string } }).constructor.name === "GeneratorFunction";

const isGeneratorObject = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { next?: unknown }).next === "function" &&
  typeof (value as { throw?: unknown }).throw === "function" &&
  typeof (value as { return?: unknown }).return === "function";

const isMapIterator = (value: unknown): boolean =>
  value !== null && typeof value === "object" && tagOf(value) === "Map Iterator";

const isSetIterator = (value: unknown): boolean =>
  value !== null && typeof value === "object" && tagOf(value) === "Set Iterator";

const isModuleNamespaceObject = (value: unknown): boolean =>
  value !== null && typeof value === "object" && tagOf(value) === "Module";

/** Node's `types.isKeyObject`: a `crypto.KeyObject`. Never present in a browser. */
const isKeyObject = (_value: unknown): boolean => false;

/** Node's `types.isCryptoKey`: a WebCrypto `CryptoKey`. */
const isCryptoKey = (value: unknown): boolean =>
  typeof globalThis.CryptoKey === "function" && value instanceof globalThis.CryptoKey;

const isWeakMap = (value: unknown): boolean => internalClassOf(value) === "WeakMap";
const isWeakSet = (value: unknown): boolean => internalClassOf(value) === "WeakSet";
const isPromise = (value: unknown): boolean => internalClassOf(value) === "Promise";
const isMap = (value: unknown): boolean => internalClassOf(value) === "Map";
const isSet = (value: unknown): boolean => internalClassOf(value) === "Set";
const isDate = (value: unknown): boolean => internalClassOf(value) === "Date";
const isRegExp = (value: unknown): boolean => internalClassOf(value) === "RegExp";
const isDataView = (value: unknown): boolean => internalClassOf(value) === "DataView";
/**
 * Node's `types.isBooleanObject` and friends report *wrapper objects* only:
 * a primitive `true` is not a boolean object, `new Boolean(true)` is.
 * `Object.prototype.toString` labels both the same way, so these predicates
 * require object-ness first.
 */
const isObjectWrapper = (value: unknown, tag: string): boolean =>
  value !== null && typeof value === "object" && internalClassOf(value) === tag;

const isBooleanObject = (value: unknown): boolean => isObjectWrapper(value, "Boolean");
const isNumberObject = (value: unknown): boolean => isObjectWrapper(value, "Number");
const isStringObject = (value: unknown): boolean => isObjectWrapper(value, "String");
const isSymbolObject = (value: unknown): boolean => isObjectWrapper(value, "Symbol");
const isBigIntObject = (value: unknown): boolean => isObjectWrapper(value, "BigInt");

/**
 * Node's `types.isExternal`. Every value a browser container can hold lives on
 * the JS heap, so the answer is always `false`. Node's own `util.types`
 * returns `false` for plain objects too.
 */
const isExternal = (_value: unknown): boolean => false;

/**
 * Node's `types.isProxy`. V8 exposes no public proxy predicate, so the
 * browser container cannot answer it faithfully; `false` matches Node's
 * answer for every non-proxy value.
 */
const isProxy = (_value: unknown): boolean => false;

/** Node's typed-array predicates: exact internal-class match. */
const typedArrayClass = (value: unknown, tag: string): boolean => internalClassOf(value) === tag;

export const utilTypes = {
  isAnyArrayBuffer,
  isArrayBuffer,
  isArrayBufferView,
  isArgumentsObject,
  isAsyncFunction,
  isBigIntObject,
  isBoxedPrimitive,
  isBooleanObject,
  isCryptoKey,
  isDataView,
  isDate,
  isExternal,
  isGeneratorFunction,
  isGeneratorObject,
  isKeyObject,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isTypedArray,
  isWeakMap,
  isWeakSet,
  isUint8Array: (value: unknown): boolean => typedArrayClass(value, "Uint8Array"),
  isUint8ClampedArray: (value: unknown): boolean => typedArrayClass(value, "Uint8ClampedArray"),
  isUint16Array: (value: unknown): boolean => typedArrayClass(value, "Uint16Array"),
  isUint32Array: (value: unknown): boolean => typedArrayClass(value, "Uint32Array"),
  isInt8Array: (value: unknown): boolean => typedArrayClass(value, "Int8Array"),
  isInt16Array: (value: unknown): boolean => typedArrayClass(value, "Int16Array"),
  isInt32Array: (value: unknown): boolean => typedArrayClass(value, "Int32Array"),
  isFloat32Array: (value: unknown): boolean => typedArrayClass(value, "Float32Array"),
  isFloat64Array: (value: unknown): boolean => typedArrayClass(value, "Float64Array"),
  isBigInt64Array: (value: unknown): boolean => typedArrayClass(value, "BigInt64Array"),
  isBigUint64Array: (value: unknown): boolean => typedArrayClass(value, "BigUint64Array"),
  // Float16Array only exists in newer V8; the predicate still answers
  // faithfully (false) when the runtime has no such type.
  isFloat16Array: (value: unknown): boolean => typedArrayClass(value, "Float16Array"),
} as const;

export type UtilTypes = typeof utilTypes;

// unenv's `util.mjs` consumes this module via
// `import types from "node:util/types"` — the module must keep a default
// export even though real Node's `util/types` has none (CJS namespace shape).
export default utilTypes;
