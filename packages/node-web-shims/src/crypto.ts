// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
import crypto from "unenv/runtime/node/crypto";
// @ts-expect-error - unenv runtime modules lack proper TypeScript declarations
export * from "unenv/runtime/node/crypto";

/**
 * Creates a node:crypto shim using WebCrypto API via unenv.
 *
 * @example
 * ```ts
 * const { createHash, randomBytes } = createCryptoShim();
 * const hash = createHash('sha256');
 * hash.update('hello');
 * console.log(hash.digest('hex'));
 * ```
 */
export const createCryptoShim = (): typeof crypto => {
  return crypto;
};

export default createCryptoShim();
