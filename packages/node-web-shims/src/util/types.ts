// `node:util/types` — faithful predicate set. unenv's module leaves most
// predicates as throwing stubs and mis-types the boxed-primitive checks
// (isBooleanObject returns true for a *primitive* boolean), so the whole
// matrix is re-implemented here against internal-slot probes: each check
// calls a prototype method that only succeeds on objects carrying the real
// slot, which stays correct for forged prototypes and Symbol.toStringTag
// spoofs — the same semantics Node gets from V8's IsXxx APIs.
import { registerInternalBinding } from "../internal/bindings.js";

const toString = Function.prototype.call.bind(Object.prototype.toString) as (
  v: unknown,
) => string;

/** Calls `fn(v)`; true when it does not throw — an internal-slot probe. */
const slot = (fn: (v: never) => unknown) => {
  const call = Function.prototype.call.bind(fn) as (v: unknown) => unknown;
  return (v: unknown): boolean => {
    if ((typeof v !== "object" && typeof v !== "function") || v === null) return false;
    try {
      call(v);
      return true;
    } catch {
      return false;
    }
  };
};

const mapSizeGet = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const setSizeGet = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;

const isArrayBufferCheck = slot(ArrayBuffer.prototype.slice);
const isDataViewCheck = slot(DataView.prototype.getUint8);
const isMapCheck = slot(mapSizeGet);
const isSetCheck = slot(setSizeGet);
const isWeakMapCheck = slot(WeakMap.prototype.has);
const isWeakSetCheck = slot(WeakSet.prototype.has);
const isPromiseCheck = slot(Promise.prototype.then);
const isRegExpCheck = slot(RegExp.prototype.exec);
const isDateCheck = slot(Date.prototype.getTime);
const isGeneratorCheck = slot((function* () {}).prototype.next);

const sharedArrayBufferByteLengthGet = (() => {
  if (typeof SharedArrayBuffer === "undefined") return undefined;
  return Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get;
})();

const isSharedArrayBufferCheck = sharedArrayBufferByteLengthGet
  ? slot(sharedArrayBufferByteLengthGet)
  : () => false;

const isWeakRefCheck =
  typeof WeakRef === "undefined"
    ? () => false
    : (v: unknown): boolean => v instanceof WeakRef;

const isFinalizationRegistryCheck =
  typeof FinalizationRegistry === "undefined"
    ? () => false
    : (v: unknown): boolean => v instanceof FinalizationRegistry;

const isCryptoKeyCheck =
  typeof CryptoKey === "undefined"
    ? () => false
    : (v: unknown): boolean => v instanceof CryptoKey;

// %TypedArray%.prototype[Symbol.toStringTag] — reads the [[TypedArrayName]]
// internal slot: real TypedArrays report their kind even with a forged
// prototype or own toStringTag; forged objects return undefined.
const typedArrayTagGet = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)!.get!;
const tagOf = (v: unknown): string | undefined => {
  if ((typeof v !== "object" && typeof v !== "function") || v === null) return undefined;
  try {
    return typedArrayTagGet.call(v) as string | undefined;
  } catch {
    return undefined;
  }
};

const boxed =
  (valueOf: (this: never) => unknown) =>
  (v: unknown): boolean => {
    if (typeof v !== "object" || v === null) return false;
    try {
      Function.prototype.call.call(valueOf, v);
      return true;
    } catch {
      return false;
    }
  };

export const isBooleanObject = boxed(Boolean.prototype.valueOf as never);
export const isNumberObject = boxed(Number.prototype.valueOf as never);
export const isStringObject = boxed(String.prototype.valueOf as never);
export const isSymbolObject = boxed(Symbol.prototype.valueOf as never);
export const isBigIntObject = boxed(BigInt.prototype.valueOf as never);

export const isBoxedPrimitive = (v: unknown): boolean =>
  isBooleanObject(v) || isNumberObject(v) || isStringObject(v) || isSymbolObject(v) || isBigIntObject(v);

// Objects standing in for native "External" handles (JSStream's
// _externalStream). A realm WeakSet brands them; internalBinding('util')
// exposes createExternal/isExternal so the same marker works from CJS
// internals shims that cannot import this module.
const externalObjects = new WeakSet<object>();

/** Marks `v` as a native-external stand-in and returns it. */
export const createExternal = <T extends object>(v: T = {} as T): T => {
  externalObjects.add(v);
  return v;
};

export const isExternal = (v: unknown): boolean =>
  (typeof v === "object" || typeof v === "function") && v !== null && externalObjects.has(v);

export const isDate = isDateCheck;
export const isArgumentsObject = (v: unknown): boolean => toString(v) === "[object Arguments]";
export const isNativeError = (v: unknown): boolean => v instanceof Error;
export const isRegExp = isRegExpCheck;
export const isAsyncFunction = (v: unknown): boolean => toString(v) === "[object AsyncFunction]";
export const isGeneratorFunction = (v: unknown): boolean =>
  toString(v) === "[object GeneratorFunction]";
export const isGeneratorObject = isGeneratorCheck;
export const isPromise = isPromiseCheck;
export const isMap = isMapCheck;
export const isSet = isSetCheck;
export const isMapIterator = (v: unknown): boolean => toString(v) === "[object Map Iterator]";
export const isSetIterator = (v: unknown): boolean => toString(v) === "[object Set Iterator]";
export const isWeakMap = isWeakMapCheck;
export const isWeakSet = isWeakSetCheck;
export const isArrayBuffer = isArrayBufferCheck;
export const isSharedArrayBuffer = isSharedArrayBufferCheck;
export const isDataView = isDataViewCheck;
export const isArrayBufferView = (v: unknown): boolean => ArrayBuffer.isView(v);
export const isTypedArray = (v: unknown): boolean => tagOf(v) !== undefined;
export const isAnyArrayBuffer = (v: unknown): boolean => isArrayBuffer(v) || isSharedArrayBuffer(v);
export const isArrayBufferDetached = (v: unknown): boolean => {
  if (!isArrayBuffer(v)) return false;
  try {
    ArrayBuffer.prototype.slice.call(v as ArrayBuffer, 0, 0);
    return false;
  } catch {
    return true;
  }
};

export const isUint8Array = (v: unknown): boolean => tagOf(v) === "Uint8Array";
export const isUint8ClampedArray = (v: unknown): boolean => tagOf(v) === "Uint8ClampedArray";
export const isUint16Array = (v: unknown): boolean => tagOf(v) === "Uint16Array";
export const isUint32Array = (v: unknown): boolean => tagOf(v) === "Uint32Array";
export const isInt8Array = (v: unknown): boolean => tagOf(v) === "Int8Array";
export const isInt16Array = (v: unknown): boolean => tagOf(v) === "Int16Array";
export const isInt32Array = (v: unknown): boolean => tagOf(v) === "Int32Array";
export const isFloat32Array = (v: unknown): boolean => tagOf(v) === "Float32Array";
export const isFloat64Array = (v: unknown): boolean => tagOf(v) === "Float64Array";
export const isBigInt64Array = (v: unknown): boolean => tagOf(v) === "BigInt64Array";
export const isBigUint64Array = (v: unknown): boolean => tagOf(v) === "BigUint64Array";

// Proxies cannot be introspected from JS; containers wrap globalThis.Proxy
// (GLOBALS_BANNER) so every proxy the program constructs is tracked here.
const proxiedObjects = (): WeakSet<object> | undefined =>
  (globalThis as { __boloProxies?: WeakSet<object> }).__boloProxies;

export const isProxy = (v: unknown): boolean =>
  (typeof v === "object" || typeof v === "function") && v !== null && (proxiedObjects()?.has(v) ?? false);

// Module namespace objects carry Symbol.toStringTag === 'Module' (fixed,
// non-configurable); our vm.SourceTextModule stamps the same tag.
export const isModuleNamespaceObject = (v: unknown): boolean =>
  typeof v === "object" && v !== null && toString(v) === "[object Module]";

export const isCryptoKey = isCryptoKeyCheck;
export const isKeyObject = (): boolean => false;
export const isWeakRef = isWeakRefCheck;
export const isFinalizationRegistry = isFinalizationRegistryCheck;

/**
 * `internalBinding('util').previewEntries` — V8's Object::PreviewEntries for
 * collection iterators: returns a flat array of the iterator's remaining
 * previews (key-value iterators contribute [key, value] pairs flattened).
 * Called with one argument the array is returned directly (WeakMap/WeakSet
 * fast path); called with an `isKeyValue` flag it returns
 * `[entries, isKeyValue]` where the second element reports pair iterators.
 */
export const previewEntries = (
  iter: unknown,
  isKeyValue?: boolean,
): unknown[] | [unknown[], boolean] | undefined => {
  const next = (iter as { next?: () => IteratorResult<unknown> } | null)?.next;
  if (iter === null || (typeof iter !== "object" && typeof iter !== "function") || typeof next !== "function") {
    return undefined;
  }
  const tag = (iter as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
  const isMapIter = tag === "Map Iterator";
  const entries: unknown[] = [];
  let sawPair = false;
  for (let i = 0; i < 100; i++) {
    const r = next.call(iter);
    if (!r || typeof r !== "object" || r.done) break;
    const v = r.value;
    if (isMapIter && Array.isArray(v) && v.length === 2) {
      sawPair = true;
      entries.push(v[0], v[1]);
    } else {
      entries.push(v);
    }
  }
  if (isKeyValue === undefined) return entries;
  return [entries, isMapIter && (entries.length === 0 || sawPair)];
};

const predicates = {
  isExternal,
  isDate,
  isArgumentsObject,
  isBigIntObject,
  isBooleanObject,
  isNumberObject,
  isStringObject,
  isSymbolObject,
  isNativeError,
  isRegExp,
  isAsyncFunction,
  isGeneratorFunction,
  isGeneratorObject,
  isPromise,
  isMap,
  isSet,
  isMapIterator,
  isSetIterator,
  isWeakMap,
  isWeakSet,
  isArrayBuffer,
  isSharedArrayBuffer,
  isDataView,
  isArrayBufferView,
  isTypedArray,
  isAnyArrayBuffer,
  isArrayBufferDetached,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isFloat32Array,
  isFloat64Array,
  isBigInt64Array,
  isBigUint64Array,
  isProxy,
  isModuleNamespaceObject,
  isCryptoKey,
  isKeyObject,
  isWeakRef,
  isFinalizationRegistry,
  isBoxedPrimitive,
};

export default predicates;

// The `util` internal binding backs node:util helpers that Node implements
// natively. Registered at module load so `internalBinding('util')` resolves
// in --expose-internals consumers (see src/internal/bindings.ts).
registerInternalBinding("util", {
  previewEntries,
  isExternal,
  createExternal,
});
