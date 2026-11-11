import { Buffer, u8ToBigInt, type BinaryLike } from "../internal/binary.js";
import {
  KeyObject,
  normalizeEcCurve,
  nobleCurve,
  nobleOkp,
  type KeyMaterial,
  type OkpCurveName,
  type PssParams,
} from "./keys.js";
import { randomU8 } from "./random.js";
import { generateRsaKeyPair, isProbablePrime } from "./rsa.js";

/**
 * `crypto.generateKey*` — synchronous keygen for rsa/rsa-pss/ec/ed25519/x25519
 * (pure JS) with a WebCrypto fast path for the async variants.
 */

export interface KeyEncodingOpts {
  type?: "pkcs1" | "spki" | "pkcs8" | "sec1";
  format?: "pem" | "der" | "jwk";
  cipher?: string;
  passphrase?: string | Uint8Array;
}

export interface GenerateKeyPairOptions {
  modulusLength?: number;
  publicExponent?: number | bigint | string | Uint8Array;
  namedCurve?: string;
  hashAlgorithm?: string;
  mgf1HashAlgorithm?: string;
  saltLength?: number;
  publicKeyEncoding?: KeyEncodingOpts;
  privateKeyEncoding?: KeyEncodingOpts;
}

type KeyPairResult = { publicKey: unknown; privateKey: unknown };
type KeyPairCallback = (err: Error | null, publicKey: unknown, privateKey: unknown) => void;

const normalizeExponent = (e?: number | bigint | string | Uint8Array): bigint => {
  if (e === undefined) return 65537n;
  if (typeof e === "bigint") return e;
  if (typeof e === "number") return BigInt(e);
  if (typeof e === "string") return u8ToBigInt(Buffer.from(e, "base64"));
  return u8ToBigInt(e);
};

const buildMaterial = (
  type: string,
  options: GenerateKeyPairOptions,
): { priv: KeyMaterial; pub: KeyMaterial } => {
  const t = type.toLowerCase();
  if (t === "rsa" || t === "rsa-pss") {
    const bits = options.modulusLength ?? 2048;
    if (!Number.isInteger(bits) || bits < 512 || bits > 16384) {
      throw Object.assign(new RangeError('The value of "options.modulusLength" is out of range'), {
        code: "ERR_OUT_OF_RANGE",
      });
    }
    const e = normalizeExponent(options.publicExponent);
    const pair = generateRsaKeyPair(bits, e);
    const pss: PssParams | undefined =
      t === "rsa-pss"
        ? {
            hashAlgorithm: options.hashAlgorithm?.toLowerCase(),
            mgf1HashAlgorithm: options.mgf1HashAlgorithm?.toLowerCase(),
            saltLength: options.saltLength,
          }
        : undefined;
    return {
      priv: { kind: "rsa", pss, ...pair },
      pub: { kind: "rsa", pss, n: pair.n, e: pair.e },
    };
  }
  if (t === "ec") {
    const curve = normalizeEcCurve(options.namedCurve ?? "P-256");
    const c = nobleCurve(curve);
    const priv = c.utils.randomSecretKey();
    const pub = c.getPublicKey(priv, false);
    return {
      priv: { kind: "ec", curve, priv, pub },
      pub: { kind: "ec", curve, pub },
    };
  }
  if (t === "ed25519" || t === "x25519") {
    const curve = t as OkpCurveName;
    const c = nobleOkp(curve);
    const priv = c.utils.randomSecretKey();
    const pub = c.getPublicKey(priv);
    return {
      priv: { kind: "okp", curve, priv, pub },
      pub: { kind: "okp", curve, pub },
    };
  }
  throw Object.assign(
    new Error(`generateKeyPair type "${type}" is not supported by the browser crypto shim`),
    { code: "ERR_CRYPTO_UNSUPPORTED_OPERATION" },
  );
};

const encodeKey = (ko: KeyObject, enc: KeyEncodingOpts | undefined): unknown => {
  if (!enc) return ko;
  return ko.export(enc);
};

const materializePair = (type: string, options: GenerateKeyPairOptions): KeyPairResult => {
  const { priv, pub } = buildMaterial(type, options);
  const privKo = new KeyObject("private", priv);
  const pubKo = new KeyObject("public", pub);
  return {
    publicKey: encodeKey(pubKo, options.publicKeyEncoding),
    privateKey: encodeKey(privKo, options.privateKeyEncoding),
  };
};

export const generateKeyPairSync = (
  type: string,
  options: GenerateKeyPairOptions = {},
): KeyPairResult => materializePair(type, options);

// WebCrypto algorithm map for the async fast path. Failures fall back to the
// pure-JS generator so exotic curves still work.
const WEBCRYPTO_ALGS: Record<
  string,
  (o: GenerateKeyPairOptions) => {
    name: string;
    namedCurve?: string;
    modulusLength?: number;
    publicExponent?: Uint8Array;
    hash?: string;
  }
> = {
  rsa: (o) => ({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: o.modulusLength ?? 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }),
  "rsa-pss": (o) => ({
    name: "RSA-PSS",
    modulusLength: o.modulusLength ?? 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: (o.hashAlgorithm ?? "SHA-256").toUpperCase().replace("SHA", "SHA-"),
  }),
  ec: (o) => ({
    name: "ECDSA",
    namedCurve:
      normalizeEcCurve(o.namedCurve ?? "P-256") === "secp256k1"
        ? ""
        : normalizeEcCurve(o.namedCurve ?? "P-256"),
  }),
  ed25519: () => ({ name: "Ed25519" }),
  x25519: () => ({ name: "X25519" }),
};

const generateKeyPairWebCrypto = async (
  type: string,
  options: GenerateKeyPairOptions,
): Promise<{ priv: KeyMaterial; pub: KeyMaterial }> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("no WebCrypto");
  const alg = WEBCRYPTO_ALGS[type.toLowerCase()](options);
  if ("namedCurve" in alg && !alg.namedCurve) throw new Error("curve not in WebCrypto");
  const usages =
    alg.name === "RSA-OAEP" || alg.name === "ECDH" || alg.name === "X25519"
      ? (["deriveBits", "deriveKey"] as KeyUsage[])
      : (["sign", "verify"] as KeyUsage[]);
  const pair = (await subtle.generateKey(alg, true, usages)) as CryptoKeyPair;
  const jwkPub = (await subtle.exportKey("jwk", pair.publicKey)) as Record<string, string>;
  const jwkPriv = (await subtle.exportKey("jwk", pair.privateKey)) as Record<string, string>;
  const t = type.toLowerCase();
  if (t === "rsa" || t === "rsa-pss") {
    const pss: PssParams | undefined =
      t === "rsa-pss"
        ? {
            hashAlgorithm: options.hashAlgorithm?.toLowerCase(),
            mgf1HashAlgorithm: options.mgf1HashAlgorithm?.toLowerCase(),
            saltLength: options.saltLength,
          }
        : undefined;
    const conv = (s: string) => u8ToBigInt(b64u(s));
    const pub: KeyMaterial = { kind: "rsa", pss, n: conv(jwkPub.n), e: conv(jwkPub.e) };
    const priv: KeyMaterial = {
      kind: "rsa",
      pss,
      n: conv(jwkPriv.n),
      e: conv(jwkPriv.e),
      d: conv(jwkPriv.d),
      p: jwkPriv.p ? conv(jwkPriv.p) : undefined,
      q: jwkPriv.q ? conv(jwkPriv.q) : undefined,
      dp: jwkPriv.dp ? conv(jwkPriv.dp) : undefined,
      dq: jwkPriv.dq ? conv(jwkPriv.dq) : undefined,
      qi: jwkPriv.qi ? conv(jwkPriv.qi) : undefined,
    };
    return { priv, pub };
  }
  if (t === "ec") {
    const curve = normalizeEcCurve(jwkPub.crv);
    const size = curve === "P-256" || curve === "secp256k1" ? 32 : curve === "P-384" ? 48 : 66;
    const x = b64u(jwkPub.x);
    const y = b64u(jwkPub.y);
    const pub = new Uint8Array(1 + 2 * size);
    pub[0] = 4;
    pub.set(x, 1 + size - x.length);
    pub.set(y, 1 + 2 * size - y.length);
    return {
      priv: { kind: "ec", curve, priv: b64u(jwkPriv.d), pub },
      pub: { kind: "ec", curve, pub },
    };
  }
  const curve = t as OkpCurveName;
  return {
    priv: { kind: "okp", curve, priv: b64u(jwkPriv.d), pub: b64u(jwkPub.x) },
    pub: { kind: "okp", curve, pub: b64u(jwkPub.x) },
  };
};

const b64u = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = globalThis.atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const generateKeyPair = (
  type: string,
  options: GenerateKeyPairOptions | KeyPairCallback | undefined,
  callback?: KeyPairCallback,
): void => {
  const opts = typeof options === "function" ? {} : (options ?? {});
  const cb = typeof options === "function" ? options : callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  const work = WEBCRYPTO_ALGS[type.toLowerCase()]
    ? generateKeyPairWebCrypto(type, opts).catch(() => buildMaterial(type, opts))
    : Promise.resolve().then(() => buildMaterial(type, opts));
  work.then(
    ({ priv, pub }) => {
      const privKo = new KeyObject("private", priv);
      const pubKo = new KeyObject("public", pub);
      queueMicrotask(() =>
        cb(
          null,
          encodeKey(pubKo, opts.publicKeyEncoding),
          encodeKey(privKo, opts.privateKeyEncoding),
        ),
      );
    },
    (err) =>
      queueMicrotask(() =>
        cb(err instanceof Error ? err : new Error(String(err)), undefined, undefined),
      ),
  );
};

// ---- generateKey (symmetric) ----

export interface GenerateKeyOptions {
  length?: number;
}

export const generateKeySync = (type: string, options: GenerateKeyOptions = {}): KeyObject => {
  const t = type.toLowerCase();
  if (t !== "hmac" && t !== "aes") {
    throw Object.assign(
      new Error(`generateKey type "${type}" is not supported by the browser crypto shim`),
      { code: "ERR_CRYPTO_UNSUPPORTED_OPERATION" },
    );
  }
  const bits = options.length ?? (t === "aes" ? 256 : 0);
  if (!Number.isInteger(bits) || bits < 8) {
    throw Object.assign(new RangeError('The value of "options.length" is out of range'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  if (t === "aes" && ![128, 192, 256].includes(bits)) {
    throw Object.assign(new RangeError("AES key length must be 128, 192 or 256 bits"), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return new KeyObject("secret", {
    kind: "secret",
    bytes: randomU8(Math.ceil(bits / 8)),
  });
};

export const generateKey = (
  type: string,
  options: GenerateKeyOptions | ((err: Error | null, key: KeyObject) => void) | undefined,
  callback?: (err: Error | null, key: KeyObject) => void,
): void => {
  const opts = typeof options === "function" ? {} : (options ?? {});
  const cb = typeof options === "function" ? options : callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  queueMicrotask(() => {
    try {
      cb(null, generateKeySync(type, opts));
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), undefined as never);
    }
  });
};

// ---- primes ----

export interface GeneratePrimeOptions {
  bigint?: boolean;
  safe?: boolean;
  add?: BinaryLike;
  rem?: BinaryLike;
}

export const generatePrimeSync = (
  size: number,
  options: GeneratePrimeOptions = {},
): Buffer | bigint => {
  if (!Number.isInteger(size) || size < 1) {
    throw Object.assign(new RangeError('The value of "size" is out of range'), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  const prime = options.safe ? genSafePrime(size) : genSizedPrime(size);
  return options.bigint ? prime : Buffer.from(bigToBytes(prime));
};

const genSizedPrime = (bits: number): bigint => {
  let candidate = u8ToBigInt(randomU8(Math.ceil(bits / 8))) | (1n << BigInt(bits - 1)) | 1n;
  while (!isProbablePrime(candidate, 16)) candidate += 2n;
  return candidate;
};

const genSafePrime = (bits: number): bigint => {
  // p safe ⇔ (p-1)/2 prime — generate a Sophie Germain prime of bits-1, then 2q+1.
  for (;;) {
    const q = genSizedPrime(bits - 1);
    const p = 2n * q + 1n;
    if (isProbablePrime(p, 16)) return p;
  }
};

export const generatePrime = (
  size: number,
  options: GeneratePrimeOptions | ((err: Error | null, prime: Buffer | bigint) => void) | undefined,
  callback?: (err: Error | null, prime: Buffer | bigint) => void,
): void => {
  const opts = typeof options === "function" ? {} : (options ?? {});
  const cb = typeof options === "function" ? options : callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  queueMicrotask(() => {
    try {
      cb(null, generatePrimeSync(size, opts));
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), undefined as never);
    }
  });
};

const bigToBytes = (v: bigint): Uint8Array => {
  const hex = v.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const checkPrimeSync = (candidate: BinaryLike, options: { checks?: number } = {}): boolean =>
  isProbablePrime(u8ToBigInt(toBytes(candidate)), options.checks ?? 8);

const toBytes = (v: BinaryLike): Uint8Array =>
  typeof v === "string"
    ? v.startsWith("0x")
      ? Uint8Array.from(Buffer.from(v.slice(2), "hex"))
      : Uint8Array.from(Buffer.from(v, "utf8"))
    : v instanceof Uint8Array
      ? v
      : ArrayBuffer.isView(v)
        ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        : new Uint8Array(v as ArrayBufferLike);

export const checkPrime = (
  candidate: BinaryLike,
  options: { checks?: number } | ((err: Error | null, result: boolean) => void) | undefined,
  callback?: (err: Error | null, result: boolean) => void,
): void => {
  const opts = typeof options === "function" ? {} : (options ?? {});
  const cb = typeof options === "function" ? options : callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  queueMicrotask(() => {
    try {
      cb(null, checkPrimeSync(candidate, opts));
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), false);
    }
  });
};
