import unenvCrypto from "unenv/node/crypto";

// Spread first so unenv's implementations are preserved, then override the
// stubs that throw "not implemented" — @yarnpkg/lockfile calls getHashes at
// import time.
const crypto = {
  ...unenvCrypto,
  getHashes: () => ["sha1", "sha256", "sha384", "sha512", "md5", "ripemd160"],
};

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

// Named export so @yarnpkg/lockfile gets it as crypto_exports.getHashes
// (pre-bundled require() returns crypto_exports, not crypto_default2)
export const getHashes = crypto.getHashes;

export default crypto;
