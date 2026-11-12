import { Buffer, toU8, type BinaryLike } from "../internal/binary.js";

const MAX_RANDOM_VALUE_BYTES = 65536;

/** `crypto.getRandomValues`-backed bytes — same engine unenv's randomBytes uses. */
export const randomU8 = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  for (let off = 0; off < size; off += MAX_RANDOM_VALUE_BYTES) {
    globalThis.crypto.getRandomValues(
      out.subarray(off, Math.min(off + MAX_RANDOM_VALUE_BYTES, size)),
    );
  }
  return out;
};

/** `crypto.randomInt` — rejection sampling over `getRandomValues`. */
export const randomInt = (
  min: number,
  max?: number,
  callback?: (err: Error | null, value: number) => void,
): number | void => {
  let lo = min;
  let hi = max;
  let cb = callback;
  if (typeof max === "function") {
    cb = max as typeof callback;
    hi = undefined;
  }
  if (hi === undefined) {
    hi = lo;
    lo = 0;
  }
  try {
    const v = randomIntSync(lo, hi);
    if (cb) queueMicrotask(() => cb(null, v));
    else return v;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (cb) queueMicrotask(() => cb(e, 0));
    else throw e;
  }
};

const randomIntSync = (min: number, max: number): number => {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw Object.assign(new RangeError('"min" and "max" must be safe integers'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  if (max <= min) {
    throw Object.assign(
      new RangeError(
        `The value of "max" is out of range. It must be greater than the value of "min" (${min}). Received ${max}`,
      ),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  const range = max - min;
  if (range <= 1) return min;
  // Rejection sampling: draw ⌈bits/8⌉ bytes, mask to the needed bits.
  // (`2 ** bits` and `%` — bitwise ops would truncate to 32 bits.)
  const bits = Math.ceil(Math.log2(range));
  const bytes = Math.ceil(bits / 8);
  const span = 2 ** bits;
  const limit = Math.floor(span / range) * range - 1;
  for (;;) {
    const draw = randomU8(bytes);
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + draw[i];
    v %= span;
    if (v <= limit) return min + (v % range);
  }
};

type FillTarget = NodeJS.ArrayBufferView | ArrayBuffer | ArrayBufferLike;

const fillView = (buffer: FillTarget, offset?: number, size?: number): Uint8Array => {
  const u8 =
    buffer instanceof Uint8Array
      ? buffer
      : ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer as ArrayBufferLike);
  const off = offset ?? 0;
  const len = size ?? u8.length - off;
  if (off < 0 || len < 0 || off + len > u8.length) {
    throw Object.assign(new RangeError("offset/size out of range"), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return u8.subarray(off, off + len);
};

export const randomFillSync = <T extends FillTarget>(
  buffer: T,
  offset?: number,
  size?: number,
): T => {
  const view = fillView(buffer, offset, size);
  for (let off = 0; off < view.length; off += MAX_RANDOM_VALUE_BYTES) {
    globalThis.crypto.getRandomValues(
      view.subarray(
        off,
        Math.min(off + MAX_RANDOM_VALUE_BYTES, view.length),
      ) as Uint8Array<ArrayBuffer>,
    );
  }
  return buffer;
};

export const randomFill = <T extends FillTarget>(
  buffer: T,
  offset: number | ((err: Error | null, buf: T) => void) | undefined,
  size: number | ((err: Error | null, buf: T) => void) | undefined,
  callback?: (err: Error | null, buf: T) => void,
): void => {
  const off = typeof offset === "number" ? offset : undefined;
  const len = typeof size === "number" ? size : undefined;
  const cb =
    (typeof offset === "function" ? offset : undefined) ??
    (typeof size === "function" ? size : undefined) ??
    callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  queueMicrotask(() => {
    try {
      randomFillSync(buffer, off, len);
      cb(null, buffer);
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), buffer);
    }
  });
};

/** `crypto.randomBytes` — Node validates the size argument up front. */
export const randomBytes = (
  size: number,
  callback?: (err: Error | null, buf: Buffer) => void,
): Buffer | void => {
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw Object.assign(
      new TypeError(
        `The "size" argument must be of type number. Received ${
          size === null ? "null" : `type ${typeof size}`
        }`,
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  if (size > 0x7fffffff) {
    throw Object.assign(
      new RangeError(`Attempt to allocate Buffer larger than maximum size: 0x7fffffff bytes`),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  const out = Buffer.from(randomU8(size));
  if (callback) {
    queueMicrotask(() => callback(null, out));
    return;
  }
  return out;
};

/** `crypto.pseudoRandomBytes` — Node's deprecated alias for randomBytes. */
export const pseudoRandomBytes = (
  size: number,
  callback?: (err: Error | null, buf: Buffer) => void,
): Buffer | void => {
  const out = Buffer.from(randomU8(size));
  if (callback) {
    queueMicrotask(() => callback(null, out));
    return;
  }
  return out;
};

/** `crypto.timingSafeEqual` — constant-time compare; throws on length mismatch. */
export const timingSafeEqual = (a: BinaryLike, b: BinaryLike): boolean => {
  const ab = toU8(a);
  const bb = toU8(b);
  if (ab.length !== bb.length) {
    throw Object.assign(new RangeError("Input buffers must have the same byte length"), {
      code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
    });
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
};
