import { Buffer as WebBuffer } from "./buffer.js";

export * from "unenv/node/string_decoder";

interface AnyBuffer {
  length: number;
  [index: number]: number;
  slice(start?: number, end?: number): AnyBuffer;
  copy(target: AnyBuffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): unknown;
  toString(encoding?: string, start?: number, end?: number): string;
}

interface BufferCtor {
  isBuffer(v: unknown): boolean;
  alloc(size: number): AnyBuffer;
  from(v: ArrayBuffer | ArrayLike<number>, byteOffset?: number, byteLength?: number): AnyBuffer;
}

// The decoder works on Buffer instances so partial-character output is
// byte-identical with `buf.toString(encoding)` — the reference Node's
// string_decoder tests compare against. Prefer the realm's global Buffer
// (injected by the container banner or a consumer polyfill) and fall back to
// unenv's implementation.
const getBuffer = (): BufferCtor =>
  (globalThis as unknown as { Buffer?: BufferCtor }).Buffer ?? (WebBuffer as unknown as BufferCtor);

const toBuffer = (buf: unknown): AnyBuffer => {
  const Buffer = getBuffer();
  if (Buffer.isBuffer(buf)) return buf as AnyBuffer;
  if (ArrayBuffer.isView(buf)) {
    const view = buf as ArrayBufferView;
    return Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }
  const err = new TypeError(
    'The "buf" argument must be an instance of Buffer, TypedArray or DataView',
  );
  (err as unknown as { code: string }).code = "ERR_INVALID_ARG_TYPE";
  throw err;
};

const isEncoding = (encoding: unknown): boolean => {
  switch (String(encoding).toLowerCase()) {
    case "hex":
    case "utf8":
    case "utf-8":
    case "ascii":
    case "binary":
    case "base64":
    case "base64url":
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
    case "latin1":
    case "raw":
      return true;
    default:
      return false;
  }
};

const normalizeEncodingInner = (enc: string): string | undefined => {
  if (!enc) return "utf8";
  let retried = false;
  for (;;) {
    switch (enc) {
      case "utf8":
      case "utf-8":
        return "utf8";
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return "utf16le";
      case "latin1":
      case "binary":
        return "latin1";
      case "base64":
      case "base64url":
      case "ascii":
      case "hex":
        return enc;
      default:
        if (retried) return undefined;
        enc = String(enc).toLowerCase();
        retried = true;
    }
  }
};

const normalizeEncoding = (enc: string): string => {
  const nenc = normalizeEncodingInner(enc);
  if (typeof nenc !== "string" && !isEncoding(enc)) {
    const err = new TypeError(`Unknown encoding: ${enc}`);
    (err as unknown as { code: string }).code = "ERR_UNKNOWN_ENCODING";
    throw err;
  }
  return nenc || enc;
};

// Buffer.toString for base64 encodings. base64url differs from base64 only in
// the alphabet's last two characters and the absence of '=' padding; unenv's
// Buffer predates the base64url alias, so translate here.
const decodeBytes = (buf: AnyBuffer, encoding: string, start?: number, end?: number): string => {
  if (encoding === "base64url") {
    return buf
      .toString("base64", start, end)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  return buf.toString(encoding, start, end);
};

// --- UTF-8 / UTF-16LE: WHATWG-faithful streaming decoders -------------------
//
// The legacy string_decoder algorithm buffers trailing partial *bytes*, but
// V8's `Buffer.toString('utf8')` is a full WHATWG decoder: an invalid
// sequence consumes its maximal subpart and emits exactly one replacement
// character, which byte-level buffering cannot reproduce. Feeding the bytes
// through `TextDecoder({ stream: true })` — the same algorithm V8 uses for
// the reference output — keeps every chunked write byte-identical with a
// one-shot `Buffer.concat(bufs).toString(enc)`, which is exactly what the
// Node string_decoder fuzz test asserts.
//
// NOTE: this holds only when the realm's `Buffer.toString('utf8')` is itself
// WHATWG-faithful (V8, or a TextDecoder-backed polyfill). bolo's realm Buffer
// (feross `buffer@6`) uses a hand-rolled decoder whose invalid-sequence
// handling differs (one U+FFFD per byte, no maximal-subpart), so the fuzz
// test's chunked-output vs one-shot-toString comparison cannot pass until
// the Buffer side is aligned — see the report.
//
// UTF-16LE has no WHATWG quirk here, but Node's own semantics are
// non-obvious: a lone high surrogate is carried across chunk boundaries and
// paired with the next unit, and a trailing lone surrogate is preserved
// literally (not replaced) — see the verified model below.

class Utf8StreamDecoder {
  #decoder = new TextDecoder("utf-8");

  write(buf: AnyBuffer): string {
    return this.#decoder.decode(new Uint8Array(buf as unknown as Uint8Array), {
      stream: true,
    });
  }

  end(): string {
    return this.#decoder.decode();
  }
}

class Utf16StreamDecoder {
  #pendingByte: number | null = null;
  #pendingHigh: number | null = null;

  write(buf: AnyBuffer): string {
    const bytes = this.#pendingByte === null ? buf : [this.#pendingByte, ...Array.from(buf)];
    this.#pendingByte = null;
    let out = "";
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) {
      const u = bytes[i] | (bytes[i + 1] << 8);
      if (this.#pendingHigh !== null) {
        if (u >= 0xdc00 && u <= 0xdfff) {
          out += String.fromCharCode(this.#pendingHigh, u);
          this.#pendingHigh = null;
          continue;
        }
        out += String.fromCharCode(this.#pendingHigh);
        this.#pendingHigh = null;
      }
      if (u >= 0xd800 && u <= 0xdbff) this.#pendingHigh = u;
      else out += String.fromCharCode(u);
    }
    if (i < bytes.length) this.#pendingByte = bytes[i];
    return out;
  }

  end(): string {
    let out = "";
    if (this.#pendingHigh !== null) {
      out += String.fromCharCode(this.#pendingHigh);
      this.#pendingHigh = null;
    }
    this.#pendingByte = null;
    return out;
  }
}

interface StringDecoderBase {
  encoding: string;
  lastNeed: number;
  lastTotal: number;
  lastChar: AnyBuffer;
}

/**
 * StringDecoder provides an interface for efficiently splitting a series of
 * buffers into a series of JS strings without breaking apart multi-byte
 * characters. utf8/utf16le run through WHATWG/Node-faithful streaming
 * decoders; base64 keeps Node's 3-byte carry; hex/ascii/latin1 pass bytes
 * straight through to `Buffer.toString`.
 */
export class StringDecoder {
  encoding: string;
  // Node's legacy state fields — kept populated for introspection parity.
  lastNeed = 0;
  lastTotal = 0;
  lastChar: AnyBuffer;

  #utf8: Utf8StreamDecoder | null = null;
  #utf16: Utf16StreamDecoder | null = null;
  #base64Carry: number[] = [];

  constructor(encoding = "utf8") {
    this.encoding = normalizeEncoding(encoding);
    const nb =
      this.encoding === "utf16le" || this.encoding === "utf8"
        ? 4
        : this.encoding === "base64" || this.encoding === "base64url"
          ? 3
          : 0;
    this.lastChar = getBuffer().alloc(nb);
    if (this.encoding === "utf8") this.#utf8 = new Utf8StreamDecoder();
    else if (this.encoding === "utf16le") this.#utf16 = new Utf16StreamDecoder();
  }

  /** Decodes `buf`, omitting any incomplete trailing multi-byte character. */
  write(buf: unknown): string {
    if (typeof buf === "string") return buf;
    const b = toBuffer(buf);
    if (this.#utf8) return this.#utf8.write(b);
    if (this.#utf16) return this.#utf16.write(b);
    if (this.encoding === "base64" || this.encoding === "base64url") {
      const carry = this.#base64Carry;
      const input = carry.length > 0 ? [...carry, ...Array.from(b)] : Array.from(b);
      const rem = input.length % 3;
      const cut = input.length - rem;
      this.#base64Carry = input.slice(cut);
      return decodeBytes(getBuffer().from(input.slice(0, cut)), this.encoding);
    }
    // Single-byte encodings pass bytes straight through.
    return decodeBytes(b, this.encoding);
  }

  /**
   * Returns any remaining input stored in the internal buffer as a string.
   * After end() is called, the decoder can be reused for new input.
   */
  end(buf?: unknown): string {
    let r = buf !== undefined ? this.write(buf) : "";
    if (this.#utf8) {
      r += this.#utf8.end();
      this.#utf8 = new Utf8StreamDecoder();
      return r;
    }
    if (this.#utf16) {
      r += this.#utf16.end();
      this.#utf16 = new Utf16StreamDecoder();
      return r;
    }
    if (this.encoding === "base64" || this.encoding === "base64url") {
      const carry = this.#base64Carry;
      this.#base64Carry = [];
      if (carry.length > 0) {
        r += decodeBytes(getBuffer().from(carry), this.encoding);
      }
      return r;
    }
    return r;
  }

  /** Returns only complete characters in `buf` from `offset` on (legacy). */
  text(buf: unknown, offset?: number): string {
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.#utf8 = this.encoding === "utf8" ? new Utf8StreamDecoder() : null;
    this.#utf16 = this.encoding === "utf16le" ? new Utf16StreamDecoder() : null;
    this.#base64Carry = [];
    const b = toBuffer(buf);
    return this.write(b.slice(offset ?? 0));
  }

  /**
   * Attempts to complete a partial character using bytes from `buf`
   * (legacy). Returns the completed character string.
   */
  fillLast(buf: unknown): string | AnyBuffer | undefined {
    return this.write(buf);
  }
}

const string_decoder = { StringDecoder };

/**
 * Creates a node:string_decoder shim backed by a real implementation —
 * unenv's `StringDecoder` is a notImplemented stub that throws on use.
 */
export const createStringDecoderShim = (): typeof string_decoder => {
  return string_decoder;
};

export default createStringDecoderShim();
