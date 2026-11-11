import { Buffer as UnenvBuffer } from "unenv/node/buffer";

/**
 * unenv's `Buffer` is typed `unknown` upstream; the shim packages always use
 * this alias — the real vendored/ambient implementation.
 */
export const Buffer = UnenvBuffer as unknown as BufferConstructor;

/**
 * Node `BinaryLike`/`Binary` inputs accepted by crypto and zlib APIs:
 * strings (encoded), TypedArrays, DataView, ArrayBuffer/SharedArrayBuffer.
 */
export type BinaryLike = string | NodeJS.ArrayBufferView | ArrayBuffer | ArrayBufferLike;

/** Normalize any BinaryLike to a `Uint8Array` view (no copy for view inputs). */
export const toU8 = (data: BinaryLike, encoding?: BufferEncoding): Uint8Array => {
  if (typeof data === "string") {
    return new Uint8Array(Buffer.from(data, encoding ?? "utf8"));
  }
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data as ArrayBufferLike);
};

/** Normalize any BinaryLike to a `Buffer` (matches Node return types). */
export const toBuffer = (data: BinaryLike, encoding?: BufferEncoding): Buffer => {
  if (typeof data === "string") return Buffer.from(data, encoding ?? "utf8");
  return Buffer.from(toU8(data));
};

export const concatU8 = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

export const u8ToBigInt = (bytes: Uint8Array): bigint => {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
};

/** Big-endian minimal-length encoding of a non-negative bigint. */
export const bigIntToU8 = (v: bigint, length?: number): Uint8Array => {
  if (v < 0n) throw new RangeError("negative bigint");
  const hex = v.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const min = new Uint8Array(padded.length / 2);
  for (let i = 0; i < min.length; i++) {
    min[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  if (length === undefined || length === min.length) return min;
  if (min.length > length) {
    // Truncate leading zero bytes only — overflow is a caller bug.
    if (min.slice(0, min.length - length).some((b) => b !== 0)) {
      throw new RangeError("bigint does not fit in requested length");
    }
    return min.slice(min.length - length);
  }
  const out = new Uint8Array(length);
  out.set(min, length - min.length);
  return out;
};

/** Node-style output encoding for digest/signature-style results. */
export const encodeOut = (
  bytes: Uint8Array,
  encoding?: BufferEncoding | "buffer",
): Buffer | string => {
  const buf = Buffer.from(bytes);
  if (encoding === undefined || encoding === "buffer") return buf;
  return buf.toString(encoding as BufferEncoding);
};
