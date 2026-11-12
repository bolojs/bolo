import buffer from "unenv/node/buffer";

/**
 * Node's `ERR_INVALID_ARG_TYPE` shape. The message mirrors Node's
 * `The "<name>" argument must be of type <type>. Received <received>`.
 */
const argTypeError = (name: string, expected: string, value: unknown): TypeError => {
  const received =
    value === null
      ? "null"
      : typeof value === "object" && value !== undefined
        ? `an instance of ${value.constructor?.name || "Object"}`
        : `type ${typeof value} (${String(value)})`;
  return Object.assign(
    new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`),
    { code: "ERR_INVALID_ARG_TYPE" },
  );
};

/**
 * Node refuses buffers larger than its 32-bit size limit with a coded
 * RangeError. Browsers cannot allocate that much anyway, but the code and
 * message must match so callers can branch on them.
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
      const enc = encodingOrOffset.toLowerCase();
      const known = [
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
      ];
      if (!known.includes(enc)) {
        throw Object.assign(new TypeError(`Unknown encoding: ${encodingOrOffset}`), {
          code: "ERR_UNKNOWN_ENCODING",
        });
      }
    }
    // Node: non-string, non-view, non-array-like first argument → coded
    // TypeError. feross's Buffer accepts anything shapeless here.
    if (typeof value !== "string") {
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
              `Received ${describe(value)}`,
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
      throw argTypeError("list", "Array", list);
    }
    list.forEach((item, index) => {
      if (!BufferClass.isBuffer(item) && !(item instanceof Uint8Array)) {
        throw Object.assign(
          new TypeError(
            `The "list[${index}]" argument must be an instance of Buffer or Uint8Array. ` +
              `Received ${describe(item)}`,
          ),
          { code: "ERR_INVALID_ARG_TYPE" },
        );
      }
    });
    return origConcat.call(this, list, length);
  };

  const origAlloc = BufferClass.alloc;
  BufferClass.alloc = function (size: unknown, fill?: unknown, encoding?: unknown): unknown {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      throw Object.assign(new TypeError('"size" argument must be of type number'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    assertAllocatable(size);
    return origAlloc.call(this, size, fill, encoding);
  };

  const origAllocUnsafe = BufferClass.allocUnsafe;
  BufferClass.allocUnsafe = function (size: unknown): unknown {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      throw Object.assign(new TypeError('"size" argument must be of type number'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
    assertAllocatable(size);
    return origAllocUnsafe.call(this, size);
  };

  const origAllocUnsafeSlow = BufferClass.allocUnsafeSlow;
  BufferClass.allocUnsafeSlow = function (size: unknown): unknown {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      throw Object.assign(new TypeError('"size" argument must be of type number'), {
        code: "ERR_INVALID_ARG_TYPE",
      });
    }
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
    if (target === undefined || target === null) {
      throw argTypeError("target", "Buffer or Uint8Array", target);
    }
    return origCopy.call(this, target, targetStart, sourceStart, sourceEnd);
  };
}

/** Node's `invalidArgTypeHelper`-style description of a bad value. */
const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "function") return `function ${value.name}`;
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    return ctor ? `an instance of ${ctor}` : String(value);
  }
  return `type ${typeof value} (${String(value)})`;
};

export * from "unenv/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
