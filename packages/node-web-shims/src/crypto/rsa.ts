import { bigIntToU8, concatU8, u8ToBigInt } from "../internal/binary.js";
import { digestBytes } from "./hashes.js";
import { modInverse } from "./keys.js";
import { randomU8 } from "./random.js";

/**
 * Pure-JS RSA core (BigInt modexp + EMSA encoders) — synchronous where
 * WebCrypto cannot be, which is every Node `*Sync`/`createSign` surface.
 */

// ---- bigint utils ----

export const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
};

/** RSA private op; uses CRT halves when primes are available. */
export const rsaPrivateOp = (
  m: { n: bigint; d: bigint; p?: bigint; q?: bigint; dp?: bigint; dq?: bigint; qi?: bigint },
  c: bigint,
): bigint => {
  if (m.p !== undefined && m.q !== undefined) {
    const dp = m.dp ?? m.d % (m.p - 1n);
    const dq = m.dq ?? m.d % (m.q - 1n);
    const qi = m.qi ?? modInverse(m.q, m.p);
    const m1 = modPow(c % m.p, dp, m.p);
    const m2 = modPow(c % m.q, dq, m.q);
    const h = (((((m1 - m2) % m.p) + m.p) % m.p) * qi) % m.p;
    return (m2 + h * m.q) % m.n;
  }
  return modPow(c, m.d, m.n);
};

export const rsaPublicOp = (m: { n: bigint; e: bigint }, s: bigint): bigint => modPow(s, m.e, m.n);

// ---- primality ----

const SMALL_PRIMES = [
  2n,
  3n,
  5n,
  7n,
  11n,
  13n,
  17n,
  19n,
  23n,
  29n,
  31n,
  37n,
  41n,
  43n,
  47n,
  53n,
  59n,
  61n,
  67n,
  71n,
  73n,
  79n,
  83n,
  89n,
  97n,
  101n,
  103n,
  107n,
  109n,
  113n,
  127n,
  131n,
  137n,
  139n,
  149n,
  151n,
  157n,
  163n,
  167n,
  173n,
  179n,
  181n,
  191n,
  193n,
  197n,
  199n,
  211n,
  223n,
  227n,
  229n,
  233n,
];

const randomBigIntBelow = (limit: bigint): bigint => {
  const bits = limit.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  return u8ToBigInt(randomU8(bytes)) % limit;
};

const millerRabin = (n: bigint, rounds: number): boolean => {
  if (n < 2n) return false;
  for (const p of SMALL_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  // n - 1 = d * 2^s
  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  witnesses: for (let i = 0; i < rounds; i++) {
    // Deterministic small bases for n < 2^64, random bases otherwise.
    const a =
      n < 1n << 64n
        ? BigInt([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37][i % 12])
        : 2n + randomBigIntBelow(n - 4n);
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witnesses;
    }
    return false;
  }
  return true;
};

/** `crypto.checkPrime` backend — Miller-Rabin with `checks` rounds (default 64ish). */
export const isProbablePrime = (n: bigint, checks = 8): boolean => millerRabin(n, checks);

// ---- RSA keygen ----

const randomCandidate = (bits: number): bigint => {
  const bytes = randomU8(Math.ceil(bits / 8));
  let v = u8ToBigInt(bytes);
  // Set the top two bits so n = p*q lands at `2*bits` modulus bits.
  v |= 1n << BigInt(bits - 1);
  v |= 1n << BigInt(bits - 2);
  v |= 1n; // odd
  return v;
};

const genPrime = (bits: number): bigint => {
  let candidate = randomCandidate(bits);
  while (!isProbablePrime(candidate, 16)) candidate += 2n;
  return candidate;
};

export interface RsaKeyPair {
  n: bigint;
  e: bigint;
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qi: bigint;
}

export const generateRsaKeyPair = (modulusBits: number, publicExponent: bigint): RsaKeyPair => {
  const half = Math.floor(modulusBits / 2);
  for (;;) {
    const p = genPrime(half);
    const q = genPrime(modulusBits - half);
    if (p === q) continue;
    const n = p * q;
    if (n.toString(2).length !== modulusBits) continue;
    const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    if (publicExponent >= lambda || gcd(publicExponent, lambda) !== 1n) continue;
    const d = modInverse(publicExponent, lambda);
    return {
      n,
      e: publicExponent,
      d,
      p,
      q,
      dp: d % (p - 1n),
      dq: d % (q - 1n),
      qi: modInverse(q, p),
    };
  }
};

export const gcd = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

// ---- EMSA-PKCS1-v1_5 ----

// DigestInfo DER prefixes (algorithm identifier + NULL per RFC 8017 A.2.4).
const DIGEST_INFO_PREFIX: Record<string, number[]> = {
  md5: [
    0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00,
    0x04, 0x10,
  ],
  sha1: [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14],
  sha224: [
    0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04, 0x05,
    0x00, 0x04, 0x1c,
  ],
  sha256: [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
  ],
  sha384: [
    0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02, 0x05,
    0x00, 0x04, 0x30,
  ],
  sha512: [
    0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03, 0x05,
    0x00, 0x04, 0x40,
  ],
  sha512224: [
    0x30, 0x2d, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x05, 0x05,
    0x00, 0x04, 0x1c,
  ],
  sha512256: [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x06, 0x05,
    0x00, 0x04, 0x20,
  ],
  ripemd160: [
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x24, 0x03, 0x02, 0x01, 0x05, 0x00, 0x04, 0x14,
  ],
};

const emsaPkcs1 = (hashAlg: string, mHash: Uint8Array, emLen: number): Uint8Array => {
  const prefix = DIGEST_INFO_PREFIX[hashAlg];
  if (!prefix) {
    throw Object.assign(new Error(`Unsupported digest for RSA PKCS#1 v1.5: "${hashAlg}"`), {
      code: "ERR_CRYPTO_INVALID_DIGEST",
    });
  }
  const t = new Uint8Array(prefix.length + mHash.length);
  t.set(prefix);
  t.set(mHash, prefix.length);
  if (emLen < t.length + 11) {
    throw Object.assign(new Error("Key too small for the given digest"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  const em = new Uint8Array(emLen);
  em[0] = 0;
  em[1] = 1;
  const ps = emLen - t.length - 3;
  em.fill(0xff, 2, 2 + ps);
  em[2 + ps] = 0;
  em.set(t, emLen - t.length);
  return em;
};

// ---- EMSA-PSS (RFC 8017 §9.1) ----

const mgf1 = (hashAlg: string, seed: Uint8Array, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  let counter = 0;
  let off = 0;
  while (off < len) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, false);
    const h = digestBytes(hashAlg, concatU8([seed, c]));
    out.set(h.subarray(0, Math.min(h.length, len - off)), off);
    off += h.length;
    counter++;
  }
  return out;
};

export const RSA_PKCS1_PADDING = 1;
export const RSA_PKCS1_PSS_PADDING = 6;

/** RSA_PSS_SALTLEN_MAX_SIGN equivalent. */
export const pssMaxSaltLen = (emLen: number, hLen: number): number => emLen - hLen - 2;

const emsaPssEncode = (
  hashAlg: string,
  mHash: Uint8Array,
  emBits: number,
  saltLen: number,
): Uint8Array => {
  const hLen = mHash.length;
  const emLen = Math.ceil(emBits / 8);
  if (emLen < hLen + saltLen + 2) {
    throw Object.assign(new Error("Key too small for the given salt length"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
  }
  const salt = randomU8(saltLen);
  const mPrime = concatU8([new Uint8Array(8), mHash, salt]);
  const h = digestBytes(hashAlg, mPrime);
  const ps = new Uint8Array(emLen - saltLen - hLen - 2);
  const db = concatU8([ps, new Uint8Array([1]), salt]);
  const dbMask = mgf1(hashAlg, h, emLen - hLen - 1);
  const maskedDb = db.map((b, i) => b ^ dbMask[i]);
  const unusedBits = 8 * emLen - emBits;
  if (unusedBits > 0) maskedDb[0] &= 0xff >>> unusedBits;
  return concatU8([maskedDb, h, new Uint8Array([0xbc])]);
};

const emsaPssVerify = (
  hashAlg: string,
  mHash: Uint8Array,
  em: Uint8Array,
  emBits: number,
  saltLen: number | "auto",
): boolean => {
  const hLen = mHash.length;
  const emLen = Math.ceil(emBits / 8);
  if (em.length !== emLen || emLen < hLen + 2) return false;
  if (em[emLen - 1] !== 0xbc) return false;
  const maskedDb = em.subarray(0, emLen - hLen - 1);
  const h = em.subarray(emLen - hLen - 1, emLen - 1);
  const unusedBits = 8 * emLen - emBits;
  if (unusedBits > 0 && maskedDb[0] & (0xff << (8 - unusedBits))) return false;
  const dbMask = mgf1(hashAlg, h, emLen - hLen - 1);
  const db = maskedDb.map((b, i) => b ^ dbMask[i]);
  if (unusedBits > 0) db[0] &= 0xff >>> unusedBits;
  let i = 0;
  while (i < db.length && db[i] === 0) i++;
  if (i >= db.length || db[i] !== 1) return false;
  const actualSaltLen = db.length - i - 1;
  if (saltLen !== "auto" && actualSaltLen !== saltLen) return false;
  const salt = db.subarray(i + 1);
  const hPrime = digestBytes(hashAlg, concatU8([new Uint8Array(8), mHash, salt]));
  return buffersEqualConstant(h, hPrime);
};

const buffersEqualConstant = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

// ---- public API used by sign/verify ----

export const rsaSign = (
  hashAlg: string,
  mHash: Uint8Array,
  key: {
    n: bigint;
    e: bigint;
    d?: bigint;
    p?: bigint;
    q?: bigint;
    dp?: bigint;
    dq?: bigint;
    qi?: bigint;
  },
  padding: number,
  saltLength?: number,
): Uint8Array => {
  if (key.d === undefined) {
    throw Object.assign(new Error("RSA signing requires a private key"), {
      code: "ERR_MISSING_PRIVATE_KEY",
    });
  }
  const emLen = Math.ceil(key.n.toString(2).length / 8);
  const emBits = key.n.toString(2).length - 1;
  const em =
    padding === RSA_PKCS1_PSS_PADDING
      ? emsaPssEncode(hashAlg, mHash, emBits, saltLength ?? pssMaxSaltLen(emLen, mHash.length))
      : emsaPkcs1(hashAlg, mHash, emLen);
  const s = rsaPrivateOp({ ...key, d: key.d }, u8ToBigInt(em));
  return bigIntToU8(s, emLen);
};

export const rsaVerify = (
  hashAlg: string,
  mHash: Uint8Array,
  signature: Uint8Array,
  key: { n: bigint; e: bigint },
  padding: number,
  saltLength?: number,
): boolean => {
  const emLen = Math.ceil(key.n.toString(2).length / 8);
  if (signature.length !== emLen) return false;
  const s = u8ToBigInt(signature);
  if (s >= key.n) return false;
  const m = rsaPublicOp(key, s);
  const em = bigIntToU8(m, emLen);
  const emBits = key.n.toString(2).length - 1;
  if (padding === RSA_PKCS1_PSS_PADDING) {
    return emsaPssVerify(hashAlg, mHash, em, emBits, saltLength ?? "auto");
  }
  let expected: Uint8Array;
  try {
    expected = emsaPkcs1(hashAlg, mHash, emLen);
  } catch {
    return false;
  }
  return buffersEqualConstant(em, expected);
};
