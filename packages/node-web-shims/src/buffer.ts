import buffer from "unenv/node/buffer";

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
}

export * from "unenv/node/buffer";

export const createBufferShim = (): typeof buffer => {
  return buffer;
};

export default createBufferShim();
