import { describe, expect, it } from "vitest";

import { types } from "../src/util.js";

/**
 * The vendored Node test `test/parallel/test-util-types.js` exercises these
 * predicates against a matrix of values. These cases mirror that matrix.
 */
describe("util.types", () => {
  it("exposes every predicate Node exposes", () => {
    expect(Object.keys(types).sort()).toEqual(
      [
        "isAnyArrayBuffer",
        "isArgumentsObject",
        "isArrayBuffer",
        "isArrayBufferView",
        "isAsyncFunction",
        "isBigInt64Array",
        "isBigIntObject",
        "isBigUint64Array",
        "isBooleanObject",
        "isBoxedPrimitive",
        "isCryptoKey",
        "isDataView",
        "isDate",
        "isExternal",
        "isFloat16Array",
        "isFloat32Array",
        "isFloat64Array",
        "isGeneratorFunction",
        "isGeneratorObject",
        "isInt16Array",
        "isInt32Array",
        "isInt8Array",
        "isKeyObject",
        "isMap",
        "isMapIterator",
        "isModuleNamespaceObject",
        "isNativeError",
        "isNumberObject",
        "isPromise",
        "isProxy",
        "isRegExp",
        "isSet",
        "isSetIterator",
        "isSharedArrayBuffer",
        "isStringObject",
        "isSymbolObject",
        "isTypedArray",
        "isUint16Array",
        "isUint32Array",
        "isUint8Array",
        "isUint8ClampedArray",
        "isWeakMap",
        "isWeakSet",
      ].sort(),
    );
  });

  it("reports primitive wrapper objects", () => {
    expect(types.isBooleanObject(new Boolean())).toBe(true);
    expect(types.isNumberObject(new Number())).toBe(true);
    expect(types.isStringObject(new String())).toBe(true);
    expect(types.isSymbolObject(Object(Symbol()))).toBe(true);
    expect(types.isBigIntObject(Object(BigInt(0)))).toBe(true);
    expect(types.isBoxedPrimitive(new Boolean())).toBe(true);
    expect(types.isBoxedPrimitive(new Number())).toBe(true);
    expect(types.isBoxedPrimitive(new String())).toBe(true);
    expect(types.isBoxedPrimitive(Object(Symbol()))).toBe(true);
    expect(types.isBoxedPrimitive(Object(BigInt(0)))).toBe(true);
    expect(types.isBoxedPrimitive(true)).toBe(false);
  });

  it("does not confuse a primitive with its wrapper", () => {
    expect(types.isBooleanObject(true)).toBe(false);
    expect(types.isNumberObject(1)).toBe(false);
    expect(types.isStringObject("a")).toBe(false);
  });

  it("detects typed arrays", () => {
    expect(types.isUint8Array(new Uint8Array())).toBe(true);
    expect(types.isUint8ClampedArray(new Uint8ClampedArray())).toBe(true);
    expect(types.isUint16Array(new Uint16Array())).toBe(true);
    expect(types.isUint32Array(new Uint32Array())).toBe(true);
    expect(types.isInt8Array(new Int8Array())).toBe(true);
    expect(types.isInt16Array(new Int16Array())).toBe(true);
    expect(types.isInt32Array(new Int32Array())).toBe(true);
    expect(types.isFloat32Array(new Float32Array())).toBe(true);
    expect(types.isFloat64Array(new Float64Array())).toBe(true);
    expect(types.isBigInt64Array(new BigInt64Array())).toBe(true);
    expect(types.isBigUint64Array(new BigUint64Array())).toBe(true);
    expect(types.isUint8Array(new Uint16Array())).toBe(false);
  });

  it("rejects a spoofed Symbol.toStringTag", () => {
    const fake = { [Symbol.toStringTag]: "Uint8Array" };
    expect(types.isUint8Array(fake)).toBe(false);
    expect(types.isTypedArray(fake)).toBe(false);
  });

  it("accepts stealthy typed arrays (prototype-swapped instances)", () => {
    const buffer = new ArrayBuffer(8);
    const stealthy = Object.setPrototypeOf(new Uint8Array(buffer), ArrayBuffer.prototype);
    expect(types.isUint8Array(stealthy)).toBe(true);
    expect(types.isTypedArray(stealthy)).toBe(true);
    expect(types.isArrayBufferView(stealthy)).toBe(true);
  });

  it("rejects fake typed arrays (bare prototype, no instance data)", () => {
    const fake = Object.create(Uint8Array.prototype);
    expect(types.isUint8Array(fake)).toBe(false);
    expect(types.isTypedArray(fake)).toBe(false);
    expect(types.isArrayBufferView(fake)).toBe(false);
  });

  it("classifies array buffers and views", () => {
    const buffer = new ArrayBuffer();
    expect(types.isArrayBuffer(buffer)).toBe(true);
    expect(types.isAnyArrayBuffer(buffer)).toBe(true);
    expect(types.isArrayBufferView(new Uint8Array(buffer))).toBe(true);
    expect(types.isArrayBufferView(new DataView(buffer))).toBe(true);
    expect(types.isTypedArray(new Uint8Array(buffer))).toBe(true);
    expect(types.isTypedArray(new DataView(buffer))).toBe(false);
    expect(types.isDataView(new DataView(buffer))).toBe(true);
  });

  it("classifies collections and iterators", () => {
    expect(types.isMap(new Map())).toBe(true);
    expect(types.isSet(new Set())).toBe(true);
    expect(types.isWeakMap(new WeakMap())).toBe(true);
    expect(types.isWeakSet(new WeakSet())).toBe(true);
    expect(types.isPromise(Promise.resolve())).toBe(true);
    expect(types.isMapIterator(new Map()[Symbol.iterator]())).toBe(true);
    expect(types.isSetIterator(new Set()[Symbol.iterator]())).toBe(true);
    expect(types.isMapIterator(new Set()[Symbol.iterator]())).toBe(false);
  });

  it("classifies functions", () => {
    expect(types.isAsyncFunction(async () => {})).toBe(true);
    expect(types.isAsyncFunction(() => {})).toBe(false);
    expect(types.isGeneratorFunction(function* () {})).toBe(true);
    expect(types.isGeneratorFunction(() => {})).toBe(false);
    expect(types.isGeneratorObject((function* () {})())).toBe(true);
    expect(types.isGeneratorObject({})).toBe(false);
  });

  it("classifies errors and dates", () => {
    expect(types.isNativeError(new Error())).toBe(true);
    expect(types.isNativeError(new TypeError())).toBe(true);
    expect(types.isNativeError({})).toBe(false);
    expect(types.isDate(new Date())).toBe(true);
    expect(types.isRegExp(/a/)).toBe(true);
  });

  it("detects arguments objects", () => {
    // eslint-disable-next-line prefer-rest-params
    expect(
      types.isArgumentsObject(
        (function () {
          return arguments;
        })(),
      ),
    ).toBe(true);
    expect(types.isArgumentsObject([])).toBe(false);
  });

  it("never reports browser values as external", () => {
    expect(types.isExternal({})).toBe(false);
    expect(types.isExternal(new ArrayBuffer())).toBe(false);
  });

  it("reports no key objects or crypto keys", () => {
    expect(types.isKeyObject()).toBe(false);
    expect(types.isKeyObject({ type: "secret" })).toBe(false);
    expect(types.isCryptoKey()).toBe(false);
  });
});
