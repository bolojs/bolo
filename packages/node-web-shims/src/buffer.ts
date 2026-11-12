import buffer from "unenv/node/buffer";

/**
 * Node's `determineSpecificType` (lib/internal/errors.js) — the text after
 * "Received" in `ERR_INVALID_ARG_TYPE` messages.
 */
const determineSpecificType = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      if (value === 0) return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
      if (Number.isNaN(value)) return "type number (NaN)";
      if (value === Infinity) return "type number (Infinity)";
      if (value === -Infinity) return "type number (-Infinity)";
      return `type number (${value})`;
    case "boolean":
      return value ? "type boolean (true)" : "type boolean (false)";
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${(value as Function).name}`;
    case "object": {
      const ctor = (value as { constructor?: { name?: string } }).constructor;
      if (ctor && typeof ctor.name === "string" && ctor.name !== "") {
        return `an instance of ${ctor.name}`;
      }
      return "an instance of Object";
    }
    case "string": {
      let s = value as string;
      if (s.length > 28) s = `${s.slice(0, 25)}...`;
      return s.includes("'") ? `type string (${JSON.stringify(s)})` : `type string ('${s}')`;
    }
    default:
      return `type ${typeof value} (${String(value)})`;
  }
};

/** Node's `ERR_INVALID_ARG_TYPE`. `expected` is the text after "must be". */
const invalidArgType = (name: string, expected: string, value: unknown): TypeError =>
  Object.assign(
    new TypeError(
      `The "${name}" argument must be ${expected}. Received ${determineSpecificType(value)}`,
    ),
    { code: "ERR_INVALID_ARG_TYPE" },
  );

/** Node's `ERR_OUT_OF_RANGE` for a numeric value outside `[min, max]`. */
const outOfRange = (name: string, range: string, value: number): RangeError =>
  Object.assign(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
    ),
    { code: "ERR_OUT_OF_RANGE" },
  );

/** Node 22's `buffer.kMaxLength` (`validateNumber(size, 'size', 0, kMaxLength)`). */
const K_MAX_LENGTH = 9007199254740991;

const KNOWN_ENCODINGS = new Set([
  "utf8",
  "utf-8",
  "ascii",
  "latin1",
  "binary",
  "base64",
  "base64url",
  "hex",
  "ucs2",
  "ucs-2",
  "utf16le",
  "utf-16le",
]);

const assertSize: (size: unknown) => asserts size is number = (size) => {
  if (typeof size !== "number") {
    throw invalidArgType("size", "of type number", size);
  }
  if (size < 0 || size > K_MAX_LENGTH || Number.isNaN(size)) {
    throw outOfRange("size", `>= 0 && <= ${K_MAX_LENGTH}`, size);
  }
};

/**
 * feross's Buffer cannot allocate past its own 32-bit limit even though Node
 * 22 allows sizes up to `Number.MAX_SAFE_INTEGER`; keep the coded RangeError
 * so callers can branch on it.
 */
const assertAllocatable = (size: number): void => {
  if (size > 0x7fffffff) {
    throw Object.assign(
      new RangeError(`Attempt to allocate Buffer larger than maximum size: 0x7fffffff bytes`),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
};

const toBase64 = (s: string): string => {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return b64;
};

const toBase64Url = (b64: string): string =>
  b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Unenv delegates to feross's `buffer@6.0.3` which does not support base64url encoding.
// Patch Buffer to support base64url encoding transparently.
const BufferClass = (buffer as unknown as { Buffer?: any }).Buffer;

if (BufferClass && !BufferClass.__bolo_base64url_patched) {
  BufferClass.__bolo_base64url_patched = true;

  const origIsEncoding = BufferClass.isEncoding;
  BufferClass.isEncoding = function (encoding: unknown): boolean {
    if (typeof encoding === "string" && encoding.toLowerCase() === "base64url") {
      return true;
    }
    return origIsEncoding.call(BufferClass, encoding);
  };

  const origToString = BufferClass.prototype.toString;
  BufferClass.prototype.toString = function (
    this: unknown,
    encoding?: string,
    start?: number,
    end?: number,
  ): string {
    if (typeof encoding === "string" && encoding.toLowerCase() === "base64url") {
      const b64 = origToString.call(this, "base64", start, end);
      return toBase64Url(b64);
    }
    return origToString.apply(this, arguments as unknown as [string, number, number]);
  };

  const origFrom = BufferClass.from;
  BufferClass.from = function (
    this: unknown,
    value: unknown,
    encodingOrOffset?: unknown,
    length?: unknown,
  ): unknown {
    if (
      typeof value === "string" &&
      typeof encodingOrOffset === "string" &&
      encodingOrOffset.toLowerCase() === "base64url"
    ) {
      return origFrom.call(this, toBase64(value), "base64");
    }
    // Node rejects unknown encodings with a coded TypeError; feross's Buffer
    // silently treats them as utf8, which broke `Buffer.from('', 'buffer')`.
    if (typeof value === "string" && typeof encodingOrOffset === "string") {
      if (!KNOWN_ENCODINGS.has(encodingOrOffset.toLowerCase())) {
        throw Object.assign(new TypeError(`Unknown encoding: ${encodingOrOffset}`), {
          code: "ERR_UNKNOWN_ENCODING",
        });
      }
    }
    // Node: non-string, non-view, non-array-like first argument → coded
    // TypeError. feross's Buffer accepts anything shapeless here.
    if (typeof value !== "string") {
      // Node honors Symbol.toPrimitive (e.g. `Buffer.from({ [Symbol.toPrimitive]: () => 'x' })`).
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive] === "function"
      ) {
        const primitive = (value as { [Symbol.toPrimitive]: (hint: string) => unknown })[
          Symbol.toPrimitive
        ]("string");
        if (typeof primitive === "string") {
          return origFrom.call(this, primitive, encodingOrOffset);
        }
      }
      const okType =
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        Array.isArray(value) ||
        (value !== null &&
          typeof value === "object" &&
          typeof (value as { length?: unknown }).length === "number");
      if (!okType) {
        throw Object.assign(
          new TypeError(
            "The first argument must be of type string or an instance of " +
              "Buffer, ArrayBuffer, or Array or an Array-like Object. " +
              `Received ${determineSpecificType(value)}`,
          ),
          { code: "ERR_INVALID_ARG_TYPE" },
        );
      }
    }
    return origFrom.apply(this, arguments as unknown as [unknown, unknown, unknown]);
  };

  const origByteLength = BufferClass.byteLength;
  BufferClass.byteLength = function (this: unknown, string: unknown, encoding?: unknown): number {
    if (
      typeof string === "string" &&
      typeof encoding === "string" &&
      encoding.toLowerCase() === "base64url"
    ) {
      return origByteLength.call(this, toBase64(string), "base64");
    }
    return origByteLength.apply(this, arguments as unknown as [unknown, unknown]);
  };

  const origWrite = BufferClass.prototype.write;
  BufferClass.prototype.write = function (
    this: unknown,
    string: string,
    offset?: unknown,
    length?: unknown,
    encoding?: unknown,
  ): number {
    let enc = encoding;
    const off = offset;
    const len = length;

    if (typeof offset === "string") {
      enc = offset;
    } else if (typeof length === "string") {
      enc = length;
    }

    if (typeof enc === "string" && enc.toLowerCase() === "base64url") {
      const b64 = toBase64(string);
      if (typeof offset === "string") {
        return origWrite.call(this, b64, "base64");
      }
      if (typeof length === "string") {
        return origWrite.call(this, b64, off, "base64");
      }
      return origWrite.call(this, b64, off, len, "base64");
    }
    return origWrite.apply(this, arguments as unknown as [string, unknown, unknown, unknown]);
  };

  // --- Node-faithful argument validation ---------------------------------
  //
  // feross's Buffer is far more permissive than Node: it accepts any object
  // for `Buffer.from`, never validates the `list` of `Buffer.concat`, and
  // allocates huge buffers instead of refusing them. Node's compat suite
  // asserts the error codes and messages, so the guards live here.

  const origConcat = BufferClass.concat;
  BufferClass.concat = function (list: unknown, length?: unknown): unknown {
    if (!Array.isArray(list)) {
      throw invalidArgType("list", "an instance of Array", list);
    }
    list.forEach((item: unknown, index: number) => {
      if (!BufferClass.isBuffer(item) && !(item instanceof Uint8Array)) {
        throw invalidArgType(`list[${index}]`, "an instance of Buffer or Uint8Array", item);
      }
    });
    return origConcat.call(this, list, length);
  };

  const origAlloc = BufferClass.alloc;
  BufferClass.alloc = function (size: unknown, fill?: unknown, encoding?: unknown): unknown {
    assertSize(size);
    assertAllocatable(size);
    if (fill !== undefined && fill !== 0 && size > 0) {
      if (typeof fill === "string") {
        // Node validates the encoding for string fills (Buffer.alloc(40, 'x', 20)).
        if (encoding != null && typeof encoding !== "string") {
          throw invalidArgType("encoding", "of type string", encoding);
        }
        if (typeof encoding === "string" && !KNOWN_ENCODINGS.has(encoding.toLowerCase())) {
          throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), {
            code: "ERR_UNKNOWN_ENCODING",
          });
        }
      } else if (
        fill !== null &&
        typeof fill === "object" &&
        (fill as { length?: number }).length === 0
      ) {
        // Node refuses zero-length fills: Buffer.alloc(1, Buffer.alloc(0)).
        const inspected = BufferClass.isBuffer(fill) ? "<Buffer >" : `${String(fill)}`;
        throw Object.assign(
          new TypeError(`The argument 'value' is invalid. Received ${inspected}`),
          {
            code: "ERR_INVALID_ARG_VALUE",
          },
        );
      }
    }
    return origAlloc.call(this, size, fill, encoding);
  };

  const origAllocUnsafe = BufferClass.allocUnsafe;
  BufferClass.allocUnsafe = function (size: unknown): unknown {
    assertSize(size);
    assertAllocatable(size);
    return origAllocUnsafe.call(this, size);
  };

  const origAllocUnsafeSlow = BufferClass.allocUnsafeSlow;
  BufferClass.allocUnsafeSlow = function (size: unknown): unknown {
    assertSize(size);
    assertAllocatable(size);
    return origAllocUnsafeSlow.call(this, size);
  };

  const origCopy = BufferClass.prototype.copy;
  BufferClass.prototype.copy = function (
    this: unknown,
    target: unknown,
    targetStart?: unknown,
    sourceStart?: unknown,
    sourceEnd?: unknown,
  ): unknown {
    if (!BufferClass.isBuffer(target) && !(target instanceof Uint8Array)) {
      throw invalidArgType("target", "an instance of Buffer or Uint8Array", target);
    }
    return origCopy.call(this, target, targetStart, sourceStart, sourceEnd);
  };
}

export * from "unenv/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
