import { hmac as nobleHmac } from "@noble/hashes/hmac.js";
import type { CHash } from "@noble/hashes/utils.js";

import { Buffer, concatU8, toU8, type BinaryLike } from "../internal/binary.js";
import { lookupHash } from "./hashes.js";
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
export class Hmac {
  #algorithm: string;
  #key: Uint8Array;
  #chunks: Uint8Array[] = [];
  #finalized = false;

  constructor(algorithm: string, key: SecretKeyInput) {
    const entry = lookupHash(algorithm); // validate eagerly like Node
    if (entry.xof || !entry.hash) {
      throw Object.assign(new Error(`HMAC does not support digest "${algorithm}"`), {
        code: "ERR_CRYPTO_INVALID_DIGEST",
      });
    }
    this.#algorithm = algorithm;
    this.#key = toSecretBytes(key);
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    if (this.#finalized) {
      throw Object.assign(new Error("Digest already called"), {
        code: "ERR_CRYPTO_HMAC_FINALIZED",
      });
    }
    this.#chunks.push(toU8(data, inputEncoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: BufferEncoding): Buffer | string {
    if (this.#finalized) {
      throw Object.assign(new Error("Digest already called"), {
        code: "ERR_CRYPTO_HMAC_FINALIZED",
      });
    }
    this.#finalized = true;
    const out = hmacBytes(this.#algorithm, this.#key, concatU8(this.#chunks));
    this.#chunks = [];
    const buf = Buffer.from(out);
    return encoding === undefined ? buf : buf.toString(encoding);
  }
}

export const createHmac = (algorithm: string, key: SecretKeyInput, _options?: unknown): Hmac =>
  new Hmac(algorithm, key);
