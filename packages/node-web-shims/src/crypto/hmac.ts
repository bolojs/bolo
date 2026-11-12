import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import type { CHash } from "@noble/hashes/utils.js";

import { Buffer, concatU8, toU8, type BinaryLike } from "../internal/binary.js";
import { argTypeError, lookupHash } from "./hashes.js";
import { KeyObject, getKeyMaterial } from "./keys.js";

export type SecretKeyInput = BinaryLike | KeyObject;

const toSecretBytes = (key: SecretKeyInput): Uint8Array => {
  if (key instanceof KeyObject) {
    const material = getKeyMaterial(key);
    if (material.kind !== "secret") {
      throw Object.assign(new TypeError("Key must be of type 'secret'"), {
        code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
      });
    }
    return material.bytes;
  }
  return toU8(key);
};

export const hmacBytes = (algorithm: string, key: Uint8Array, data: Uint8Array): Uint8Array =>
  nobleHmac(lookupHash(algorithm).hash as unknown as CHash, key, data) as Uint8Array;

/**
 * `crypto.Hmac` — streaming HMAC. Same rationale as `Hash`: no real Transform
 * underneath, imperative surface only.
 */
export class HmacImpl {
  #algorithm: string;
  #key: Uint8Array;
  #chunks: Uint8Array[] = [];
  #finalized = false;

  constructor(algorithm: string, key: SecretKeyInput) {
    if (typeof algorithm !== "string") {
      throw argTypeError("hmac", "string", algorithm);
    }
    const entry = lookupHash(algorithm); // validate eagerly like Node
    if (entry.xof || !entry.hash) {
      throw Object.assign(new Error(`Invalid digest: ${algorithm}`), {
        code: "ERR_CRYPTO_INVALID_DIGEST",
      });
    }
    if (
      key === null ||
      key === undefined ||
      (typeof key !== "string" &&
        !ArrayBuffer.isView(key) &&
        !(key instanceof ArrayBuffer) &&
        !(key instanceof KeyObject))
    ) {
      throw argTypeError(
        "key",
        "string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
        key,
      );
    }
    this.#algorithm = algorithm;
    this.#key = toSecretBytes(key);
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    if (this.#finalized) {
      throw Object.assign(new Error("Digest already called"), {
        code: "ERR_CRYPTO_HASH_FINALIZED",
      });
    }
    if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
      throw argTypeError("data", ["string", "Buffer", "TypedArray", "DataView"], data);
    }
    this.#chunks.push(toU8(data, inputEncoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: BufferEncoding | { toString(): string }): Buffer | string {
    // Node's HMAC digest is idempotent after finalization: a second call
    // returns the empty digest instead of throwing.
    if (this.#finalized) {
      const empty = Buffer.alloc(0);
      if (encoding === undefined) return empty;
      const enc = typeof encoding === "object" ? String(encoding) : (encoding as string);
      if (enc.toLowerCase() === "buffer") return empty;
      return empty.toString(enc as BufferEncoding);
    }
    this.#finalized = true;
    const out = hmacBytes(this.#algorithm, this.#key, concatU8(this.#chunks));
    this.#chunks = [];
    const buf = Buffer.from(out);
    if (encoding === undefined) return buf;
    const enc = typeof encoding === "object" ? String(encoding) : (encoding as string);
    if (enc.toLowerCase() === "buffer") return buf;
    return buf.toString(enc as BufferEncoding);
  }
}

/**
 * `crypto.Hmac` — like `Hash`, Node's constructor works without `new`, so a
 * plain function wrapping the class preserves `instanceof` via prototype.
 */
export const Hmac = function Hmac(algorithm: string, key: SecretKeyInput): HmacImpl {
  return new HmacImpl(algorithm, key);
} as unknown as typeof HmacImpl;
Hmac.prototype = HmacImpl.prototype;

export const createHmac = (
  algorithm: string,
  key: SecretKeyInput,
  _options?: unknown,
): HmacImpl => {
  if (typeof algorithm !== "string") throw argTypeError("hmac", "string", algorithm);
  return new HmacImpl(algorithm, key);
};
