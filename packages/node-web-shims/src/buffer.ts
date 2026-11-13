import buffer from "unenv/node/buffer";
import { inspect } from "./util.js";

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
      const ctor = (value as { constructor?: unknown }).constructor;
      // Node: `value.constructor && 'name' in value.constructor` — the `in`
      // check (not own-property) and no empty-name guard; otherwise it falls
      // back to inspect(value, { depth: -1 }).
      if (
        ctor !== null &&
        ctor !== undefined &&
        (typeof ctor === "object" || typeof ctor === "function") &&
        "name" in (ctor as object)
      ) {
        return `an instance of ${(ctor as { name: unknown }).name}`;
      }
      return inspect(value, { depth: -1 });
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

// Node's ERR_INVALID_ARG_TYPE expected-type classification
// (lib/internal/errors.js): lowercase JS types, Capitalized class names, and
// everything else.
const K_TYPES = new Set([
  "string",
  "function",
  "number",
  "object",
  "Function",
  "Object",
  "boolean",
  "bigint",
  "symbol",
]);
const CLASS_RE = /^[A-Z][a-zA-Z0-9]*$/;

const formatList = (array: string[], type = "or"): string => {
  switch (array.length) {
    case 0:
      return "";
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    default:
      return `${array.slice(0, -1).join(", ")} ${type} ${array[array.length - 1]}`;
  }
};

/**
 * Node's `ERR_INVALID_ARG_TYPE`. `expected` is the list of accepted types
 * (e.g. `"number"`, or `["Buffer", "Uint8Array"]`); `name` ending in
 * " argument" is used verbatim (`The first argument must be ...`).
 */
const invalidArgType = (name: string, expected: string | string[], actual: unknown): TypeError => {
  const list = Array.isArray(expected) ? expected : [expected];
  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of list) {
    if (K_TYPES.has(value)) types.push(value.toLowerCase());
    else if (CLASS_RE.test(value)) instances.push(value);
    else other.push(value);
  }
  let msg = "The ";
  if (name.endsWith(" argument")) {
    msg += `${name} `;
  } else {
    msg += `"${name}" ${name.includes(".") ? "property" : "argument"} `;
  }
  msg += "must be ";
  if (types.length > 0) {
    msg += `${types.length > 1 ? "one of type" : "of type"} ${formatList(types)}`;
    if (instances.length > 0 || other.length > 0) msg += " or ";
  }
  if (instances.length > 0) {
    msg += `an instance of ${other.length > 0 ? instances.join(", ") : formatList(instances)}`;
    if (other.length > 0) msg += " or ";
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other)}`;
    } else {
      if (other[0][0] !== other[0][0].toLowerCase()) msg += "an ";
      msg += other[0];
    }
  }
  msg += `. Received ${determineSpecificType(actual)}`;
  return Object.assign(new TypeError(msg), { code: "ERR_INVALID_ARG_TYPE" });
};

const addNumericalSeparator = (num: string): string => {
  // Node's internal addNumericalSeparator: group integer digits in threes
  // from the right with '_'; used by ERR_OUT_OF_RANGE for |int| > 2**32.
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(num);
  if (!match) return num;
  const int = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  return `${match[1]}${int}${match[3] ?? ""}`;
};

/** Node's `ERR_OUT_OF_RANGE` for a numeric value outside `[min, max]`. */
const outOfRange = (name: string, range: string, value: number): RangeError => {
  let received: string;
  if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) {
    received = addNumericalSeparator(String(value));
  } else {
    received = String(value);
  }
  return Object.assign(
    new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
    ),
    { code: "ERR_OUT_OF_RANGE" },
  );
};

/** Node's `ERR_BUFFER_OUT_OF_BOUNDS` — RangeError, optional name. */
const bufferOutOfBounds = (name?: string): RangeError =>
  Object.assign(
    new RangeError(
      name
        ? `"${name}" is outside of buffer bounds`
        : "Attempt to access memory outside buffer bounds",
    ),
    { code: "ERR_BUFFER_OUT_OF_BOUNDS" },
  );

/** Node 22's `buffer.kMaxLength` (= `v8::Uint8Array::kMaxLength`). */
const K_MAX_LENGTH = 9007199254740991;

export const kMaxLength = K_MAX_LENGTH;

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

const assertEncoding = (encoding: unknown): void => {
  if (typeof encoding !== "string") {
    throw invalidArgType("encoding", "string", encoding);
  }
  if (!KNOWN_ENCODINGS.has(encoding.toLowerCase())) {
    throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), {
      code: "ERR_UNKNOWN_ENCODING",
    });
  }
};

/** Node's `validateNumber(value, name, 0, kMaxLength)` (Buffer.alloc*). */
const assertSize: (size: unknown) => asserts size is number = (size) => {
  if (typeof size !== "number") {
    throw invalidArgType("size", "number", size);
  }
  if (size < 0 || size > K_MAX_LENGTH || Number.isNaN(size)) {
    throw outOfRange("size", `>= 0 && <= ${K_MAX_LENGTH}`, size);
  }
};

/**
 * feross's Buffer cannot allocate past V8's own typed-array ceiling even
 * though Node 22 allows sizes up to `kMaxLength`. Node lets the underlying
 * `new Uint8Array(size)` throw, which surfaces V8's RangeError wording
 * (`Invalid typed array length: N`) — mirror that instead of inventing a
 * coded error (test-buffer-alloc asserts on the message).
 */
const assertAllocatable = (size: number): void => {
  if (size > 0x7fffffff) {
    throw new RangeError(`Invalid typed array length: ${size}`);
  }
};

/** Node's `validateInteger(value, name, min, max)` — safe-integer range check. */
const validateInteger = (
  value: unknown,
  name: string,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw Object.assign(
      new RangeError(
        `The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`,
      ),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value;
};

/** Node's `validateOffset` — `validateInteger` bounded to `[min, max]`. */
const validateOffset = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number") {
    throw invalidArgType(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw Object.assign(
      new RangeError(
        `The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`,
      ),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  if (value < min || value > max) {
    throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value;
};

const isAnyArrayBuffer = (value: unknown): value is ArrayBuffer => {
  if (value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return true;
  // Cross-realm ArrayBuffers (vm.runInNewContext) fail `instanceof`; the
  // [[ArrayBufferData]] internal slot is what Node's isAnyArrayBuffer checks.
  if (value !== null && typeof value === "object") {
    const tag = Object.prototype.toString.call(value);
    return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
  }
  return false;
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

if (BufferClass && !BufferClass.__bolo_node22_patched) {
  BufferClass.__bolo_node22_patched = true;

  const origIsEncoding = BufferClass.isEncoding;
  BufferClass.isEncoding = function (encoding: unknown): boolean {
    if (typeof encoding === "string" && encoding.length !== 0) {
      const normalized = encoding.toLowerCase();
      if (KNOWN_ENCODINGS.has(normalized)) return true;
    }
    return origIsEncoding.call(BufferClass, encoding);
  };

  const origToString = BufferClass.prototype.toString;
  // V8 decodes Buffer utf8 through the WHATWG algorithm (maximal-subpart
  // invalid-sequence handling, no BOM stripping); feross's hand-rolled
  // decoder emits one U+FFFD per invalid byte, which diverges from Node on
  // malformed input and broke test-string-decoder-fuzz's chunked-vs-one-shot
  // comparison. Route utf8 through TextDecoder — `ignoreBOM: true` keeps a
  // leading BOM as U+FEFF like Node's toString.
  const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  BufferClass.prototype.toString = function (
    this: unknown,
    encoding?: string,
    start?: number,
    end?: number,
  ): string {
    if (arguments.length === 0) {
      const view = this as Uint8Array;
      return utf8Decoder.decode(view);
    }
    const enc = typeof encoding === "string" ? encoding.toLowerCase() : "utf8";
    if (enc === "base64url") {
      const b64 = origToString.call(this, "base64", start, end);
      return toBase64Url(b64);
    }
    if (enc === "utf8" || enc === "utf-8") {
      const view = this as Uint8Array;
      const len = view.length;
      let s = start === undefined || start <= 0 ? 0 : start >= len ? len : start | 0;
      let e = end === undefined || end > len ? len : end | 0;
      if (e <= s) return "";
      return utf8Decoder.decode(view.subarray(s, e));
    }
    if (encoding === undefined) {
      const view = this as Uint8Array;
      return utf8Decoder.decode(view);
    }
    // Node validates the encoding and throws ERR_UNKNOWN_ENCODING.
    assertEncoding(encoding);
    return origToString.apply(this, arguments as unknown as [string, number, number]);
  };
  // Node: Buffer.prototype.toLocaleString === Buffer.prototype.toString.
  BufferClass.prototype.toLocaleString = BufferClass.prototype.toString;

  const origByteLength = BufferClass.byteLength;
  BufferClass.byteLength = function (this: unknown, string: unknown, encoding?: unknown): number {
    // Node's byteLength accepts Buffer/ArrayBuffer views and returns their
    // byteLength; anything else non-string is ERR_INVALID_ARG_TYPE.
    if (typeof string !== "string") {
      if (ArrayBuffer.isView(string) || isAnyArrayBuffer(string)) {
        return (string as { byteLength: number }).byteLength;
      }
      throw invalidArgType("string", ["string", "Buffer", "ArrayBuffer"], string);
    }
    if (typeof encoding === "string" && encoding.toLowerCase() === "base64url") {
      return origByteLength.call(this, toBase64(string), "base64");
    }
    return origByteLength.call(this, string, encoding);
  };

  // --- Node-faithful Buffer.from (lib/buffer.js `Buffer.from`) -------------

  const fromArrayBuffer = (obj: ArrayBuffer, byteOffset?: unknown, length?: unknown): unknown => {
    let offset: number;
    if (byteOffset === undefined) {
      offset = 0;
    } else {
      offset = +(byteOffset as number);
      if (Number.isNaN(offset)) offset = 0;
    }
    const maxLength = obj.byteLength - offset;
    if (maxLength < 0) throw bufferOutOfBounds("offset");
    let len: number;
    if (length === undefined) {
      len = maxLength;
    } else {
      len = +(length as number);
      if (len > 0) {
        if (len > maxLength) throw bufferOutOfBounds("length");
      } else {
        len = 0;
      }
    }
    return origFrom.call(BufferClass, new Uint8Array(obj, offset, len));
  };

  const toLength = (value: unknown): number => {
    // ToLength: ToIntegerOrInfinity clamped to [0, 2^53 - 1].
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
  };

  const fromArrayLike = (obj: { length: number; [index: number]: unknown }): unknown => {
    const len = toLength(obj.length);
    if (len <= 0) return origFrom.call(BufferClass, new Uint8Array(0));
    const out = new Uint8Array(len); // throws 'Invalid typed array length: N'
    for (let i = 0; i < len; i++) out[i] = obj[i] as number;
    return origFrom.call(BufferClass, out);
  };

  const fromObject = (obj: Record<string, unknown>): unknown => {
    if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
      if (typeof obj.length !== "number") {
        // `{ buffer: arrayBuffer }` without a length — Node reads the whole
        // buffer via byteOffset/length (both optional).
        if (isAnyArrayBuffer(obj.buffer)) {
          return fromArrayBuffer(
            obj.buffer as ArrayBuffer,
            (obj as { byteOffset?: unknown }).byteOffset,
            (obj as { length?: unknown }).length,
          );
        }
        return origFrom.call(BufferClass, new Uint8Array(0));
      }
      return fromArrayLike(obj as { length: number });
    }
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return fromArrayLike(obj.data as unknown as { length: number });
    }
    return undefined;
  };

  const origFrom = BufferClass.from;
  BufferClass.from = function (
    this: unknown,
    value: unknown,
    encodingOrOffset?: unknown,
    length?: unknown,
  ): unknown {
    if (typeof value === "string") {
      if (typeof encodingOrOffset === "string" && encodingOrOffset.toLowerCase() === "base64url") {
        return origFrom.call(this, toBase64(value), "base64");
      }
      if (typeof encodingOrOffset === "string") {
        assertEncoding(encodingOrOffset);
      }
      // Node's fromString ignores non-string encodings (utf8 default).
      return origFrom.call(
        this,
        value,
        typeof encodingOrOffset === "string" ? encodingOrOffset : undefined,
      );
    }

    if (typeof value === "object" && value !== null) {
      if (isAnyArrayBuffer(value)) {
        return fromArrayBuffer(value as ArrayBuffer, encodingOrOffset, length);
      }

      // Typed arrays (incl. Buffer) copy through feross's native path.
      // DataView has no .length — Node routes it through fromObject's
      // ArrayBuffer-buffer branch (empty buffer), so exclude it here.
      if (ArrayBuffer.isView(value) && typeof (value as { length?: unknown }).length === "number") {
        return origFrom.call(this, value);
      }

      // Node unwraps valueOf() when it yields a different string/object.
      const valueOf = (value as { valueOf?: unknown }).valueOf;
      if (typeof valueOf === "function") {
        const v = (valueOf as () => unknown).call(value);
        if (v != null && v !== value && (typeof v === "string" || typeof v === "object")) {
          return BufferClass.from(v, encodingOrOffset, length);
        }
      }

      const fromObj = fromObject(value as Record<string, unknown>);
      if (fromObj !== undefined) return fromObj;

      const toPrimitive = (value as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive];
      if (typeof toPrimitive === "function") {
        const primitive = (toPrimitive as (hint: string) => unknown).call(value, "string");
        if (typeof primitive === "string") {
          return BufferClass.from(primitive, encodingOrOffset);
        }
      }
    }

    throw invalidArgType(
      "first argument",
      ["string", "Buffer", "ArrayBuffer", "SharedArrayBuffer", "Array", "Array-like Object"],
      value,
    );
  };

  // --- Node-faithful Buffer.copyBytesFrom ---------------------------------

  BufferClass.copyBytesFrom = function (
    this: unknown,
    view: unknown,
    offset?: unknown,
    length?: unknown,
  ): unknown {
    // Node's isTypedArray: an ArrayBuffer view with a length (excludes DataView).
    if (!ArrayBuffer.isView(view) || typeof (view as { length?: unknown }).length !== "number") {
      throw invalidArgType("view", ["TypedArray"], view);
    }
    const viewLength = (view as unknown as { length: number }).length;
    if (viewLength === 0) {
      return origAllocUnsafeSlow.call(BufferClass, 0);
    }
    let v: unknown = view;
    if (offset !== undefined || length !== undefined) {
      let off: number;
      if (offset !== undefined) {
        off = validateInteger(offset, "offset", 0);
        if (off >= viewLength) return origAllocUnsafeSlow.call(BufferClass, 0);
      } else {
        off = 0;
      }
      let end: number;
      if (length !== undefined) {
        const len = validateInteger(length, "length", 0);
        end = off + len;
      } else {
        end = viewLength;
      }
      v = (view as unknown as { subarray: (a: number, b: number) => unknown }).subarray(off, end);
    }
    // Copy the underlying bytes into a fresh Buffer (a snapshot, matching
    // Node's fromArrayLike(new Uint8Array(buffer, byteOffset, byteLength))).
    const u8 = new Uint8Array(
      (v as unknown as { buffer: ArrayBuffer }).buffer,
      (v as unknown as { byteOffset: number }).byteOffset,
      (v as unknown as { byteLength: number }).byteLength,
    );
    return origFrom.call(BufferClass, Array.from(u8));
  };

  // --- Node-faithful write()/copy()/alloc() argument validation ------------

  const origWrite = BufferClass.prototype.write;
  BufferClass.prototype.write = function (
    this: unknown,
    string: string,
    offset?: unknown,
    length?: unknown,
    encoding?: unknown,
  ): number {
    const self = this as Uint8Array;
    let off: unknown = offset;
    let len: unknown = length;
    let enc: unknown = encoding;

    // Node's Buffer#write argument normalization (lib/buffer.js).
    if (offset === undefined) {
      return origWrite.call(this, string, 0, self.length);
    }
    if (length === undefined && typeof offset === "string") {
      enc = offset;
      len = self.length;
      off = 0;
    } else {
      validateOffset(off, "offset", 0, self.length);
      const remaining = self.length - (off as number);
      if (length === undefined) {
        len = remaining;
      } else if (typeof length === "string") {
        enc = length;
        len = remaining;
      } else {
        validateOffset(len, "length", 0, self.length);
        if ((len as number) > remaining) len = remaining;
      }
    }

    if (enc === undefined || enc === null) {
      return origWrite.call(this, string, off as number, len as number);
    }
    // Node's getEncodingOps only accepts strings; anything else is
    // ERR_UNKNOWN_ENCODING (not ERR_INVALID_ARG_TYPE).
    if (typeof enc !== "string") {
      throw Object.assign(new TypeError(`Unknown encoding: ${String(enc)}`), {
        code: "ERR_UNKNOWN_ENCODING",
      });
    }
    const encLower = enc.toLowerCase();
    if (encLower === "base64url") {
      return origWrite.call(this, toBase64(string), off as number, len as number, "base64");
    }
    if (!KNOWN_ENCODINGS.has(encLower)) {
      throw Object.assign(new TypeError(`Unknown encoding: ${enc}`), {
        code: "ERR_UNKNOWN_ENCODING",
      });
    }
    return origWrite.call(this, string, off as number, len as number, enc);
  };

  const origConcat = BufferClass.concat;
  BufferClass.concat = function (list: unknown, length?: unknown): unknown {
    if (!Array.isArray(list)) {
      throw invalidArgType("list", ["Array"], list);
    }
    if (length !== undefined) {
      if (typeof length !== "number") {
        throw invalidArgType("length", "number", length);
      }
      assertAllocatable(length);
    }
    list.forEach((item: unknown, index: number) => {
      if (!BufferClass.isBuffer(item) && !(item instanceof Uint8Array)) {
        throw invalidArgType(`list[${index}]`, ["Buffer", "Uint8Array"], item);
      }
    });
    return origConcat.call(this, list, length);
  };

  const origAlloc = BufferClass.alloc;
  BufferClass.alloc = function (size: unknown, fill?: unknown, encoding?: unknown): unknown {
    assertSize(size);
    assertAllocatable(size);
    if (fill !== undefined && fill !== 0 && (size as number) > 0) {
      if (typeof fill === "string") {
        // Node validates the encoding only when one is supplied.
        if (encoding !== undefined) assertEncoding(encoding);
        // Node's _fill validates that string fills decode completely for
        // hex/base64; a partial decode is ERR_INVALID_ARG_VALUE.
        if (typeof encoding === "string") {
          const encLower = encoding.toLowerCase();
          if (encLower === "hex" || encLower === "base64" || encLower === "base64url") {
            const decoded = origFrom.call(
              BufferClass,
              encLower === "hex" ? fill : encLower === "base64url" ? toBase64(fill) : fill,
              encLower === "base64url" ? "base64" : encLower,
            ) as unknown as { toString(encoding?: string): string; length: number };
            const roundTrip =
              encLower === "hex"
                ? decoded.toString("hex") === fill.toLowerCase() || decoded.toString("hex") === fill
                : true;
            if (!roundTrip || decoded.length === 0) {
              throw Object.assign(
                new TypeError(
                  `The argument 'value' is invalid. Received ${inspect(fill, { depth: -1 })}`,
                ),
                { code: "ERR_INVALID_ARG_VALUE" },
              );
            }
          }
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
          { code: "ERR_INVALID_ARG_VALUE" },
        );
      } else if (typeof fill === "object" && fill !== null) {
        // Node's _fill: object fill must have a numeric valueOf? Actually Node
        // accepts number/string/Buffer/TypedArray fills only.
        const isView = ArrayBuffer.isView(fill);
        if (!isView) {
          throw invalidArgType("fill", ["string", "Buffer", "TypedArray"], fill);
        }
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

  // Node's Buffer#copy → _copy: validates source/target are Uint8Arrays and
  // normalizes offsets with toInteger (lenient: NaN→default, floats→floor).
  const origCopy = BufferClass.prototype.copy;
  const toInteger = (value: unknown, defaultVal: number): number => {
    // Node's toInteger: non-numbers yield the default (no coercion).
    if (typeof value !== "number") return defaultVal;
    const n = value;
    if (Number.isNaN(n)) return defaultVal;
    if (n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER) {
      return n % 1 === 0 ? n : Math.floor(n);
    }
    return defaultVal;
  };
  BufferClass.prototype.copy = function (
    this: unknown,
    target: unknown,
    targetStart?: unknown,
    sourceStart?: unknown,
    sourceEnd?: unknown,
  ): number {
    const source = this as Uint8Array;
    if (!BufferClass.isBuffer(target) && !(target instanceof Uint8Array)) {
      throw invalidArgType("target", ["Buffer", "Uint8Array"], target);
    }
    const tgt = target as Uint8Array;
    let tStart: number;
    if (targetStart === undefined) {
      tStart = 0;
    } else {
      tStart = toInteger(targetStart, 0);
      if (tStart < 0) throw outOfRange("targetStart", ">= 0", tStart);
    }
    let sStart: number;
    if (sourceStart === undefined) {
      sStart = 0;
    } else {
      sStart = toInteger(sourceStart, 0);
      if (sStart < 0 || sStart > source.length) {
        throw outOfRange("sourceStart", `>= 0 && <= ${source.length}`, sStart);
      }
    }
    let sEnd: number;
    if (sourceEnd === undefined) {
      sEnd = source.length;
    } else {
      sEnd = toInteger(sourceEnd, 0);
      if (sEnd < 0) throw outOfRange("sourceEnd", ">= 0", sEnd);
    }
    return origCopy.call(this, tgt, tStart, sStart, sEnd) as number;
  };

  // unenv's constants.MAX_LENGTH mirrors its own (smaller) kMaxLength.
  const constants = (buffer as unknown as { constants?: { MAX_LENGTH?: number } }).constants;
  if (constants) constants.MAX_LENGTH = K_MAX_LENGTH;

  // --- Node-faithful read*/write* bounds -----------------------------------
  //
  // feross throws bare RangeErrors for out-of-bounds access; Node throws
  // coded ERR_OUT_OF_RANGE RangeErrors. Wrap every offset-taking method so
  // the code survives (test-buffer-alloc asserts { code: 'ERR_OUT_OF_RANGE' }).

  const checkOffset = (offset: unknown, name: string, min: number, max: number): number => {
    if (typeof offset !== "number") {
      throw invalidArgType(name, "number", offset);
    }
    if (!Number.isInteger(offset)) {
      throw Object.assign(
        new RangeError(
          `The value of "${name}" is out of range. It must be an integer. Received ${String(offset)}`,
        ),
        { code: "ERR_OUT_OF_RANGE" },
      );
    }
    if (offset < min || offset > max) {
      throw outOfRange(name, `>= ${min} && <= ${max}`, offset);
    }
    return offset;
  };

  const proto = BufferClass.prototype as Record<string, (...args: unknown[]) => unknown>;
  const wrapReadWrite = (
    name: string,
    sizeFor: (args: unknown[], isWrite: boolean) => number,
  ): void => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    const isWrite = name.startsWith("write");
    proto[name] = function (this: Uint8Array, ...args: unknown[]): unknown {
      const offsetIndex = isWrite ? 1 : 0;
      const offset = args[offsetIndex];
      if (offset === undefined) {
        // Node: missing offset defaults to 0 (reads) — feross handles it.
        return orig.apply(this, args);
      }
      const needed = sizeFor(args, isWrite);
      const max = this.length - needed;
      checkOffset(offset, "offset", 0, max);
      return orig.apply(this, args);
    };
  };

  // Fixed-size methods.
  const fixedSize: Record<string, number> = {
    readInt8: 1,
    readUInt8: 1,
    writeInt8: 1,
    writeUInt8: 1,
    readInt16LE: 2,
    readInt16BE: 2,
    readUInt16LE: 2,
    readUInt16BE: 2,
    writeInt16LE: 2,
    writeInt16BE: 2,
    writeUInt16LE: 2,
    writeUInt16BE: 2,
    readInt32LE: 4,
    readInt32BE: 4,
    readUInt32LE: 4,
    readUInt32BE: 4,
    writeInt32LE: 4,
    writeInt32BE: 4,
    writeUInt32LE: 4,
    writeUInt32BE: 4,
    readFloatLE: 4,
    readFloatBE: 4,
    writeFloatLE: 4,
    writeFloatBE: 4,
    readDoubleLE: 8,
    readDoubleBE: 8,
    writeDoubleLE: 8,
    writeDoubleBE: 8,
    readBigInt64LE: 8,
    readBigInt64BE: 8,
    readBigUInt64LE: 8,
    readBigUInt64BE: 8,
    writeBigInt64LE: 8,
    writeBigInt64BE: 8,
    writeBigUInt64LE: 8,
    writeBigUInt64BE: 8,
  };
  for (const [name, size] of Object.entries(fixedSize)) {
    wrapReadWrite(name, () => size);
  }
  // Variable-width LE/BE int methods take byteLength (default 6, range 0-6).
  // write*(value, offset, byteLength); read*(offset, byteLength).
  const varWidth = /^(read|write)(U?Int)(LE|BE)$/;
  for (const name of Object.keys(proto)) {
    if (!varWidth.test(name) || name in fixedSize) continue;
    wrapReadWrite(name, (args, isWrite) => {
      const byteLength = args[isWrite ? 2 : 1];
      const n = typeof byteLength === "number" ? byteLength : 6;
      return n;
    });
  }
}

export * from "unenv/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
