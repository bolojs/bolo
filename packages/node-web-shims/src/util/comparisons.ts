/**
 * Port of Node v22 `lib/internal/util/comparisons.js` (isDeepEqual /
 * isDeepStrictEqual).
 *
 * unenv's assert uses a JSON.stringify approximation, which compares
 * `undefined` properties, ignores prototypes and symbol keys, and treats
 * `{ a: undefined }` and `{}` as equal. Node's semantics are stricter, so
 * the assert shim needs its own implementation to produce byte-faithful
 * error messages and correct pass/fail results.
 *
 * Differences from upstream that are forced by the browser environment:
 * - `getOwnNonIndexProperties(val, filter)` is replaced by a JS
 *   implementation that filters out array index keys and keeps only
 *   enumerable own properties.
 * - `internalBinding('buffer').compare` is replaced by a byte-wise
 *   comparison of the underlying ArrayBuffer.
 * - `internalBinding('util')` flags (ONLY_ENUMERABLE / SKIP_SYMBOLS) are
 *   inlined.
 */

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

const SKIP_SYMBOLS = 0b10;

const objectToString = Object.prototype.toString;

const isArrayBufferView = (value: unknown): boolean => ArrayBuffer.isView(value as ArrayBufferView);

const isAnyArrayBuffer = (value: unknown): boolean =>
  value instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);

const BOXED_TAGS = new Set([
  "[object Number]",
  "[object String]",
  "[object Boolean]",
  "[object BigInt]",
  "[object Symbol]",
]);

const isBoxedPrimitive = (value: unknown): boolean =>
  typeof value === "object" && value !== null && BOXED_TAGS.has(objectToString.call(value));

const isDate = (value: unknown): boolean => objectToString.call(value) === "[object Date]";
const isRegExp = (value: unknown): boolean => objectToString.call(value) === "[object RegExp]";
const isMap = (value: unknown): boolean => objectToString.call(value) === "[object Map]";
const isSet = (value: unknown): boolean => objectToString.call(value) === "[object Set]";
const isNativeError = (value: unknown): boolean => objectToString.call(value) === "[object Error]";

/** Array index check matching V8's `IsArrayIndex`. */
const isArrayIndex = (key: string): boolean => {
  if (key === "") return false;
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 0xffffffff && String(n) === key;
};

/**
 * Port of `getOwnNonIndexProperties(val, filter)` from Node's internal
 * binding: own property names that are not array indices.
 */
const getOwnNonIndexProperties = (value: object, filter: number): (string | symbol)[] => {
  const names = Object.getOwnPropertyNames(value);
  const result: (string | symbol)[] = [];
  for (const name of names) {
    if (Array.isArray(value) && isArrayIndex(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) continue;
    if (filter & SKIP_SYMBOLS) continue;
    if (!descriptor.enumerable) continue;
    result.push(name);
  }
  return result;
};

const areSimilarRegExps = (a: RegExp, b: RegExp): boolean =>
  a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;

const bytesOf = (value: ArrayBufferView): Uint8Array =>
  new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

const areSimilarTypedArrays = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  const left = bytesOf(a);
  const right = bytesOf(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

const areEqualArrayBuffers = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

const isEqualBoxedPrimitive = (val1: unknown, val2: unknown): boolean => {
  const tag = objectToString.call(val1);
  if (tag === "[object Number]") {
    return (
      objectToString.call(val2) === "[object Number]" &&
      Object.is(Number.prototype.valueOf.call(val1), Number.prototype.valueOf.call(val2))
    );
  }
  if (tag === "[object String]") {
    return (
      objectToString.call(val2) === "[object String]" &&
      String.prototype.valueOf.call(val1) === String.prototype.valueOf.call(val2)
    );
  }
  if (tag === "[object Boolean]") {
    return (
      objectToString.call(val2) === "[object Boolean]" &&
      Boolean.prototype.valueOf.call(val1) === Boolean.prototype.valueOf.call(val2)
    );
  }
  if (tag === "[object BigInt]") {
    return (
      objectToString.call(val2) === "[object BigInt]" &&
      BigInt.prototype.valueOf.call(val1) === BigInt.prototype.valueOf.call(val2)
    );
  }
  if (tag === "[object Symbol]") {
    return (
      objectToString.call(val2) === "[object Symbol]" &&
      Symbol.prototype.valueOf.call(val1) === Symbol.prototype.valueOf.call(val2)
    );
  }
  return false;
};

type Memos = {
  set: Set<unknown> | undefined;
  a: unknown;
  b: unknown;
  c: unknown;
  d: unknown;
  deep: boolean;
  deleteFailures: boolean;
};

const getEnumerables = (val: object, keys: (string | symbol)[]): (string | symbol)[] =>
  keys.filter((k) => Object.prototype.propertyIsEnumerable.call(val, k));

const innerDeepEqual = (
  val1: unknown,
  val2: unknown,
  strict: boolean,
  memos: Memos | undefined,
): boolean => {
  if (val1 === val2) {
    return val1 !== 0 || Object.is(val1, val2) || !strict;
  }

  if (strict) {
    if (typeof val1 === "number") {
      return Number.isNaN(val1) && Number.isNaN(val2);
    }
    if (
      typeof val2 !== "object" ||
      typeof val1 !== "object" ||
      val1 === null ||
      val2 === null ||
      Object.getPrototypeOf(val1) !== Object.getPrototypeOf(val2)
    ) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== "object") {
      if (val2 === null || typeof val2 !== "object") {
        // eslint-disable-next-line eqeqeq
        return val1 == val2 || (Number.isNaN(val1) && Number.isNaN(val2));
      }
      return false;
    }
    if (val2 === null || typeof val2 !== "object") {
      return false;
    }
  }

  const val1Tag = objectToString.call(val1);
  const val2Tag = objectToString.call(val2);
  if (val1Tag !== val2Tag) return false;

  if (Array.isArray(val1)) {
    if (!Array.isArray(val2) || val1.length !== val2.length) return false;
    const filter = strict ? 0 : SKIP_SYMBOLS;
    const keys1 = getOwnNonIndexProperties(val1, filter);
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (keys1.length !== keys2.length) return false;
    return keyCheck(val1, val2, strict, memos, kIsArray, keys1);
  }
  if (val1Tag === "[object Object]") {
    return keyCheck(val1, val2, strict, memos, kNoIterator);
  }
  if (isDate(val1)) {
    if (!isDate(val2) || Date.prototype.getTime.call(val1) !== Date.prototype.getTime.call(val2)) {
      return false;
    }
  } else if (isRegExp(val1)) {
    if (!isRegExp(val2) || !areSimilarRegExps(val1 as RegExp, val2 as RegExp)) return false;
  } else if (isArrayBufferView(val1)) {
    const tag = Object.prototype.toString.call(val1);
    if (tag !== Object.prototype.toString.call(val2)) return false;
    if (!areSimilarTypedArrays(val1 as ArrayBufferView, val2 as ArrayBufferView)) return false;
    const filter = strict ? 0 : SKIP_SYMBOLS;
    const keys1 = getOwnNonIndexProperties(val1 as object, filter);
    const keys2 = getOwnNonIndexProperties(val2 as object, filter);
    if (keys1.length !== keys2.length) return false;
    return keyCheck(val1, val2, strict, memos, kNoIterator, keys1);
  } else if (isSet(val1)) {
    if (!isSet(val2) || (val1 as Set<unknown>).size !== (val2 as Set<unknown>).size) return false;
    return keyCheck(val1, val2, strict, memos, kIsSet);
  } else if (isMap(val1)) {
    if (
      !isMap(val2) ||
      (val1 as Map<unknown, unknown>).size !== (val2 as Map<unknown, unknown>).size
    ) {
      return false;
    }
    return keyCheck(val1, val2, strict, memos, kIsMap);
  } else if (isAnyArrayBuffer(val1)) {
    if (
      !isAnyArrayBuffer(val2) ||
      !areEqualArrayBuffers(val1 as ArrayBuffer, val2 as ArrayBuffer)
    ) {
      return false;
    }
  } else if (isNativeError(val1) || val1 instanceof Error) {
    if (
      (!isNativeError(val2) && !(val2 instanceof Error)) ||
      (val1 as Error).message !== (val2 as Error).message ||
      (val1 as Error).name !== (val2 as Error).name
    ) {
      return false;
    }
  } else if (isBoxedPrimitive(val1)) {
    if (!isEqualBoxedPrimitive(val1, val2)) return false;
  } else if (
    Array.isArray(val2) ||
    isArrayBufferView(val2) ||
    isSet(val2) ||
    isMap(val2) ||
    isDate(val2) ||
    isRegExp(val2) ||
    isAnyArrayBuffer(val2) ||
    isBoxedPrimitive(val2) ||
    isNativeError(val2) ||
    val2 instanceof Error
  ) {
    return false;
  }
  return keyCheck(val1, val2, strict, memos, kNoIterator);
};

const keyCheck = (
  val1: unknown,
  val2: unknown,
  strict: boolean,
  memos: Memos | undefined,
  iterationType: number,
  aKeys?: (string | symbol)[],
): boolean => {
  const isArrayLikeObject = aKeys !== undefined;
  let keys = aKeys;
  if (keys === undefined) {
    keys = Object.keys(val1 as object);
  }

  if (keys.length > 0) {
    for (const key of keys) {
      if (!Object.prototype.propertyIsEnumerable.call(val2, key)) return false;
    }
  }

  if (!isArrayLikeObject) {
    if (keys.length !== Object.keys(val2 as object).length) return false;

    if (strict) {
      const symbolKeysA = Object.getOwnPropertySymbols(val1 as object);
      if (symbolKeysA.length !== 0) {
        let count = 0;
        for (const key of symbolKeysA) {
          if (Object.prototype.propertyIsEnumerable.call(val1, key)) {
            if (!Object.prototype.propertyIsEnumerable.call(val2, key)) return false;
            keys.push(key);
            count += 1;
          } else if (Object.prototype.propertyIsEnumerable.call(val2, key)) {
            return false;
          }
        }
        const symbolKeysB = Object.getOwnPropertySymbols(val2 as object);
        if (
          symbolKeysA.length !== symbolKeysB.length &&
          getEnumerables(val2 as object, symbolKeysB).length !== count
        ) {
          return false;
        }
      } else {
        const symbolKeysB = Object.getOwnPropertySymbols(val2 as object);
        if (symbolKeysB.length !== 0 && getEnumerables(val2 as object, symbolKeysB).length !== 0) {
          return false;
        }
      }
    }
  }

  if (
    keys.length === 0 &&
    (iterationType === kNoIterator ||
      (iterationType === kIsArray && (val1 as unknown[]).length === 0) ||
      (val1 as Set<unknown>).size === 0)
  ) {
    return true;
  }

  let memosState = memos;
  if (memosState === undefined) {
    memosState = {
      set: undefined,
      a: val1,
      b: val2,
      c: undefined,
      d: undefined,
      deep: false,
      deleteFailures: false,
    };
    return objEquiv(val1, val2, strict, keys, memosState, iterationType);
  }

  if (memosState.set === undefined) {
    if (memosState.deep === false) {
      if (memosState.a === val1) {
        if (memosState.b === val2) return true;
      }
      memosState.c = val1;
      memosState.d = val2;
      memosState.deep = true;
      const result = objEquiv(val1, val2, strict, keys, memosState, iterationType);
      memosState.deep = false;
      return result;
    }
    const set = new Set<unknown>();
    set.add(memosState.a);
    set.add(memosState.b);
    set.add(memosState.c);
    set.add(memosState.d);
    memosState.set = set;
  }

  const set = memosState.set;
  const originalSize = set.size;
  set.add(val1);
  set.add(val2);
  if (originalSize === set.size) return true;

  const areEq = objEquiv(val1, val2, strict, keys, memosState, iterationType);

  if (areEq || memosState.deleteFailures) {
    set.delete(val1);
    set.delete(val2);
  }

  return areEq;
};

const objEquiv = (
  a: unknown,
  b: unknown,
  strict: boolean,
  aKeys: (string | symbol)[],
  memos: Memos,
  iterationType: number,
): boolean => {
  // The pair must have equivalent values for every corresponding key.
  if (aKeys.length > 0) {
    for (const key of aKeys) {
      if (
        !innerDeepEqual(
          (a as Record<string | symbol, unknown>)[key as string],
          (b as Record<string | symbol, unknown>)[key as string],
          strict,
          memos,
        )
      ) {
        return false;
      }
    }
  }

  if (iterationType === kIsArray) {
    const arr = a as unknown[];
    for (let i = 0; i < arr.length; i += 1) {
      if (Object.prototype.hasOwnProperty.call(a, i)) {
        if (
          !Object.prototype.hasOwnProperty.call(b, i) ||
          !innerDeepEqual(arr[i], (b as unknown[])[i], strict, memos)
        ) {
          return false;
        }
      } else if (Object.prototype.hasOwnProperty.call(b, i)) {
        return false;
      } else {
        // Array is sparse.
        const keysA = Object.keys(a as object);
        for (; i < keysA.length; i += 1) {
          const key = keysA[i];
          if (
            !Object.prototype.hasOwnProperty.call(b, key) ||
            !innerDeepEqual(
              (a as Record<string, unknown>)[key],
              (b as Record<string, unknown>)[key],
              strict,
              memos,
            )
          ) {
            return false;
          }
        }
        return keysA.length === Object.keys(b as object).length;
      }
    }
  } else if (iterationType === kIsSet) {
    if (!setEquiv(a as Set<unknown>, b as Set<unknown>, strict, memos)) return false;
  } else if (iterationType === kIsMap) {
    if (!mapEquiv(a as Map<unknown, unknown>, b as Map<unknown, unknown>, strict, memos))
      return false;
  }

  return true;
};

/** Node's setEquiv (lib/internal/util/comparisons.js). */
const setEquiv = (a: Set<unknown>, b: Set<unknown>, strict: boolean, memos: Memos): boolean => {
  if (a.size !== b.size) return false;
  memos.deleteFailures = false;
  for (const value of a) {
    if (!b.has(value)) {
      let matches = false;
      for (const other of b) {
        if (innerDeepEqual(value, other, strict, memos)) {
          matches = true;
          break;
        }
      }
      if (!matches) return false;
    }
  }
  return true;
};

/** Node's mapEquiv (lib/internal/util/comparisons.js). */
const mapEquiv = (
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  strict: boolean,
  memos: Memos,
): boolean => {
  if (a.size !== b.size) return false;
  memos.deleteFailures = false;
  for (const [key, value] of a) {
    if (!Object.is(key, Map.prototype.get.call(b, key))) {
      let matches = false;
      for (const [otherKey, otherValue] of b) {
        if (innerDeepEqual(key, otherKey, strict, memos)) {
          matches = true;
          if (!innerDeepEqual(value, otherValue, strict, memos)) return false;
          break;
        }
      }
      if (!matches) return false;
    } else if (!innerDeepEqual(value, Map.prototype.get.call(b, key), strict, memos)) {
      return false;
    }
  }
  return true;
};

/** Loose deep equality (Node's `isDeepEqual`). */
export const isDeepEqual = (val1: unknown, val2: unknown): boolean =>
  innerDeepEqual(val1, val2, false, undefined);

/** Strict deep equality (Node's `isDeepStrictEqual`). */
export const isDeepStrictEqual = (val1: unknown, val2: unknown): boolean =>
  innerDeepEqual(val1, val2, true, undefined);
