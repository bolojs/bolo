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

// Checks the type of a UTF-8 byte, whether it's ASCII, a leading byte, or a
// continuation byte. If an invalid byte is detected, -2 is returned.
const utf8CheckByte = (byte: number): number => {
  if (byte <= 0x7f) return 0;
  else if (byte >> 5 === 0x06) return 2;
  else if (byte >> 4 === 0x0e) return 3;
  else if (byte >> 3 === 0x1e) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
};

// Checks at most 3 bytes at the end of a Buffer in order to detect an
// incomplete multi-byte UTF-8 character. The total number of bytes (2, 3, or
// 4) needed to complete the UTF-8 character (if applicable) are returned.
const utf8CheckIncomplete = (self: StringDecoderBase, buf: AnyBuffer, i: number): number => {
  let j = buf.length - 1;
  if (j < i) return 0;
  let nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;
      else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
};

// Validates as many continuation bytes for a multi-byte UTF-8 character as
// needed or are available. If we see a non-continuation byte where we expect
// one, we "replace" the validated continuation bytes we've seen so far with a
// single UTF-8 replacement character ('�'), to match v8's UTF-8 decoding
// behavior.
const utf8CheckExtraBytes = (self: StringDecoderBase, buf: AnyBuffer): string | undefined => {
  if ((buf[0] & 0xc0) !== 0x80) {
    self.lastNeed = 0;
    return "�";
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xc0) !== 0x80) {
      self.lastNeed = 1;
      return "�";
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xc0) !== 0x80) {
        self.lastNeed = 2;
        return "�";
      }
    }
  }
  return undefined;
};

interface StringDecoderBase {
  encoding: string;
  lastNeed: number;
  lastTotal: number;
  lastChar: AnyBuffer;
}

/**
 * StringDecoder provides an interface for efficiently splitting a series of
 * buffers into a series of JS strings without breaking apart multi-byte
 * characters. Ported from Node's pure-JS string_decoder (pre-native
 * implementation) with `base64url` support added.
 */
export class StringDecoder {
  encoding: string;
  lastNeed = 0;
  lastTotal = 0;
  lastChar: AnyBuffer;

  constructor(encoding = "utf8") {
    this.encoding = normalizeEncoding(encoding);
    const nb =
      this.encoding === "utf16le" || this.encoding === "utf8"
        ? 4
        : this.encoding === "base64" || this.encoding === "base64url"
          ? 3
          : 0;
    this.lastChar = getBuffer().alloc(nb);
  }

  /** Decodes `buf`, omitting any incomplete trailing multi-byte character. */
  write(buf: unknown): string {
    if (typeof buf === "string") return buf;
    const b = toBuffer(buf);
    if (b.length === 0) return "";
    let r: string | undefined;
    let i: number;
    if (this.lastNeed) {
      r = this.#fillLast(b);
      if (r === undefined) return "";
      i = this.lastNeed;
      this.lastNeed = 0;
    } else {
      i = 0;
    }
    if (i < b.length) return r ? r + this.#text(b, i) : this.#text(b, i);
    return r || "";
  }

  /**
   * Returns any remaining input stored in the internal buffer as a string.
   * After end() is called, the decoder can be reused for new input.
   */
  end(buf?: unknown): string {
    let r = buf !== undefined ? this.write(buf) : "";
    if (this.lastNeed) {
      switch (this.encoding) {
        case "utf8":
          // For UTF-8 a replacement character is appended on a partial char.
          r += "�";
          break;
        case "utf16le": {
          // For UTF-16LE we do not explicitly append a replacement character;
          // emit whatever complete bytes are buffered.
          const end = this.lastTotal - this.lastNeed;
          r += decodeBytes(this.lastChar, "utf16le", 0, end);
          break;
        }
        case "base64":
        case "base64url":
          r += decodeBytes(this.lastChar, this.encoding, 0, 3 - this.lastNeed);
          break;
        default:
          break;
      }
      this.lastNeed = 0;
      this.lastTotal = 0;
    }
    return r;
  }

  /** Returns only complete characters in `buf` from `offset` on (legacy). */
  text(buf: unknown, offset?: number): string {
    this.lastNeed = 0;
    this.lastTotal = 0;
    const b = toBuffer(buf);
    return this.write(b.slice(offset ?? 0));
  }

  /**
   * Attempts to complete a partial character using bytes from `buf`
   * (legacy). Returns the completed character string, or a Buffer with the
   * buffered bytes when still incomplete.
   */
  fillLast(buf: unknown): string | AnyBuffer | undefined {
    const b = toBuffer(buf);
    const r = this.#fillLast(b);
    if (r === undefined) return this.lastChar.slice(0, this.lastTotal);
    return r;
  }

  // --- per-encoding internals (Node's utf8/utf16le/base64 code paths) ---

  #fillLast(buf: AnyBuffer): string | undefined {
    if (this.encoding === "utf8") return utf8FillLast(this, buf);
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
      return decodeBytes(this.lastChar, this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
    this.lastNeed -= buf.length;
    return undefined;
  }

  #text(buf: AnyBuffer, i: number): string {
    switch (this.encoding) {
      case "utf16le":
        return utf16Text(this, buf, i);
      case "base64":
      case "base64url":
        return base64Text(this, buf, i);
      case "utf8":
        return utf8Text(this, buf, i);
      default:
        // Single-byte encodings pass bytes straight through.
        return decodeBytes(buf, this.encoding, i);
    }
  }
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
const utf8FillLast = (self: StringDecoderBase, buf: AnyBuffer): string | undefined => {
  const p = self.lastTotal - self.lastNeed;
  const r = utf8CheckExtraBytes(self, buf);
  if (r !== undefined) return r;
  if (self.lastNeed <= buf.length) {
    buf.copy(self.lastChar, p, 0, self.lastNeed);
    return decodeBytes(self.lastChar, self.encoding, 0, self.lastTotal);
  }
  buf.copy(self.lastChar, p, 0, buf.length);
  self.lastNeed -= buf.length;
  return undefined;
};

// Returns all complete UTF-8 characters in a Buffer. If the Buffer ended on a
// partial character, the character's bytes are buffered until the required
// number of bytes are available.
const utf8Text = (self: StringDecoderBase, buf: AnyBuffer, i: number): string => {
  const total = utf8CheckIncomplete(self, buf, i);
  if (!self.lastNeed) return decodeBytes(buf, "utf8", i);
  self.lastTotal = total;
  const end = buf.length - (total - self.lastNeed);
  buf.copy(self.lastChar, 0, end);
  return decodeBytes(buf, "utf8", i, end);
};

// UTF-16LE typically needs two bytes per character, but even if we have an
// even number of bytes available, we need to check if we end on a leading/
// high surrogate. In that case, we need to wait for the next two bytes in
// order to decode the last character properly.
const utf16Text = (self: StringDecoderBase, buf: AnyBuffer, i: number): string => {
  if ((buf.length - i) % 2 === 0) {
    const r = decodeBytes(buf, "utf16le", i);
    if (r) {
      const c = r.charCodeAt(r.length - 1);
      if (c >= 0xd800 && c <= 0xdbff) {
        self.lastNeed = 2;
        self.lastTotal = 4;
        self.lastChar[0] = buf[buf.length - 2];
        self.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  self.lastNeed = 1;
  self.lastTotal = 2;
  self.lastChar[0] = buf[buf.length - 1];
  return decodeBytes(buf, "utf16le", i, buf.length - 1);
};

const base64Text = (self: StringDecoderBase, buf: AnyBuffer, i: number): string => {
  const n = (buf.length - i) % 3;
  if (n === 0) return decodeBytes(buf, self.encoding, i);
  self.lastNeed = 3 - n;
  self.lastTotal = 3;
  if (n === 1) {
    self.lastChar[0] = buf[buf.length - 1];
  } else {
    self.lastChar[0] = buf[buf.length - 2];
    self.lastChar[1] = buf[buf.length - 1];
  }
  return decodeBytes(buf, self.encoding, i, buf.length - n);
};

const string_decoder = { StringDecoder };

/**
 * Creates a node:string_decoder shim backed by a real implementation —
 * unenv's `StringDecoder` is a notImplemented stub that throws on use.
 */
export const createStringDecoderShim = (): typeof string_decoder => {
  return string_decoder;
};

export default createStringDecoderShim();
