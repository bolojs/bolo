import unenvCrypto from "unenv/node/crypto";

import {
  Hash,
  createHash,
  digestBytes,
  getHashes,
  hash,
  normalizeHashName,
} from "./crypto/hashes.js";
import { Hmac, createHmac, hmacBytes } from "./crypto/hmac.js";
import { hkdf, hkdfSync, pbkdf2, pbkdf2Sync, scrypt, scryptSync } from "./crypto/kdf.js";
import { KeyObject, createPrivateKey, createPublicKey, createSecretKey } from "./crypto/keys.js";
import {
  checkPrime,
  checkPrimeSync,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  generatePrime,
  generatePrimeSync,
} from "./crypto/keygen.js";
import {
  pseudoRandomBytes,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  timingSafeEqual,
} from "./crypto/random.js";
import { Sign, Verify, createSign, createVerify, sign, verify } from "./crypto/sign.js";

/**
 * Full `node:crypto` surface: unenv supplies the still-unimplemented stubs
 * (ciphers, DH/ECDH, certificates — spread first), WebCrypto covers
 * randomness/`subtle`, and noble hashes/curves plus a pure-BigInt RSA core
 * cover the synchronous breadth SubtleCrypto can't reach.
 */
const crypto = {
  ...unenvCrypto,

  // ---- implemented here (unenv's versions throw "not implemented") ----
  getHashes,
  createHash,
  Hash,
  createHmac,
  Hmac,
  hash,

  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,

  randomInt,
  randomFill,
  randomFillSync,
  pseudoRandomBytes,
  randomBytes,
  timingSafeEqual,

  createSecretKey,
  createPrivateKey,
  createPublicKey,
  KeyObject,

  createSign,
  createVerify,
  Sign,
  Verify,
  sign,
  verify,

  generateKey,
  generateKeySync,
  generateKeyPair,
  generateKeyPairSync,
  generatePrime,
  generatePrimeSync,
  checkPrime,
  checkPrimeSync,

  getFips: () => false,
  setFips: (enabled: boolean) => {
    if (enabled) {
      throw Object.assign(
        new Error("crypto.setFips: FIPS mode is not supported in the browser crypto shim"),
        { code: "ERR_CRYPTO_FIPS_UNAVAILABLE" },
      );
    }
    return false;
  },
  secureHeapUsed: () => ({ total: 0, used: 0, min: 0 }),

  // Keep WebCrypto-backed overrides (unenv's stubs are already correct, but
  // pin them here like the previous shim did).
  randomUUID: (options?: RandomUUIDOptions) => randomUuid(options),
};

/**
 * Node's `randomUUID(options)` — the options bag is validated the way Node
 * validates it (a non-object throws `ERR_INVALID_ARG_TYPE`, and
 * `disableEntropyCache` must be a boolean).
 */
export interface RandomUUIDOptions {
  disableEntropyCache?: boolean;
}

const randomUuid = (options?: RandomUUIDOptions): string => {
  if (options === undefined) return globalThis.crypto.randomUUID();
  if (options === null || typeof options !== "object") {
    throw Object.assign(
      new TypeError(
        `The "options" argument must be of type object. Received ${
          options === null ? "null" : `type ${typeof options}`
        }`,
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  if (
    options.disableEntropyCache !== undefined &&
    typeof options.disableEntropyCache !== "boolean"
  ) {
    throw Object.assign(
      new TypeError(
        `The "options.disableEntropyCache" property must be of type boolean. Received type ${typeof options.disableEntropyCache}`,
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  return globalThis.crypto.randomUUID();
};

/**
 * Creates a node:crypto shim on WebCrypto + pure-JS primitives.
 *
 * @example
 * ```ts
 * const { createHash, pbkdf2Sync } = createCryptoShim();
 * createHash('sha256').update('hello').digest('hex');
 * pbkdf2Sync('password', 'salt', 1000, 32, 'sha256');
 * ```
 */
export const createCryptoShim = (): typeof crypto => {
  return crypto;
};

// Named exports so static `import { createHash } from "crypto"` (aliased to
// this file) and the `bolo-node-shim:*` `Object.keys` re-export both work.
export {
  getHashes,
  createHash,
  Hash,
  createHmac,
  Hmac,
  hash,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  hkdf,
  hkdfSync,
  randomInt,
  randomFill,
  randomFillSync,
  pseudoRandomBytes,
  randomBytes,
  timingSafeEqual,
  createSecretKey,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  createSign,
  createVerify,
  Sign,
  Verify,
  sign,
  verify,
  generateKey,
  generateKeySync,
  generateKeyPair,
  generateKeyPairSync,
  generatePrime,
  generatePrimeSync,
  checkPrime,
  checkPrimeSync,
  normalizeHashName,
  digestBytes,
  hmacBytes,
};

const unenv = unenvCrypto as typeof import("node:crypto");

export const randomUUID = crypto.randomUUID;
export const getFips = crypto.getFips;
export const setFips = crypto.setFips;
export const secureHeapUsed = crypto.secureHeapUsed;
export const constants = unenv.constants;
export const webcrypto = unenv.webcrypto;
export const subtle = unenv.subtle;
// `rng`/`prng` are long-removed from @types/node but live in unenv — keep
// them exported for packages that still reach for the aliases.
export const rng = (unenvCrypto as Record<string, unknown>).rng;
export const prng = (unenvCrypto as Record<string, unknown>).prng;
export const getRandomValues = unenv.getRandomValues;
export const fips = unenv.fips;
export const DEFAULT_ENCODING = undefined;

export default crypto;
