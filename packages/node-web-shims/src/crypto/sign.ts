import { ed25519 } from "@noble/curves/ed25519.js";

import {
  Buffer,
  bigIntToU8,
  concatU8,
  toU8,
  u8ToBigInt,
  type BinaryLike,
} from "../internal/binary.js";
import { TAG, derInt, derIntEncode, derSeq, parseDer } from "./der.js";
import { digestBytes, lookupHash } from "./hashes.js";
import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  ecCurveByteSize,
  getKeyMaterial,
  nobleCurve,
  publicMaterial,
  type KeyMaterial,
} from "./keys.js";
import { RSA_PKCS1_PADDING, RSA_PKCS1_PSS_PADDING, rsaSign, rsaVerify } from "./rsa.js";

/**
 * `crypto.sign`/`verify`/`createSign`/`createVerify` — RSA (PKCS#1 v1.5 and
 * PSS), ECDSA (P-256/P-384/P-521/secp256k1) and Ed25519, all synchronous via
 * BigInt modexp and noble curves.
 */

export interface SignKeyOptions {
  key: unknown;
  format?: "pem" | "der" | "jwk";
  type?: string;
  encoding?: string;
  passphrase?: string | Uint8Array;
  padding?: number;
  saltLength?: number;
  dsaEncoding?: "der" | "ieee-p1363";
}

type KeyArg = KeyObject | string | Uint8Array | SignKeyOptions | { kty: string };

interface ResolvedSignKey {
  material: KeyMaterial;
  padding?: number;
  saltLength?: number;
  dsaEncoding?: "der" | "ieee-p1363";
}

const isOptionsWrapper = (v: unknown): v is SignKeyOptions =>
  typeof v === "object" && v !== null && "key" in v && !(v instanceof KeyObject);

const resolveKey = (key: KeyArg, purpose: "sign" | "verify"): ResolvedSignKey => {
  let inner: unknown = key;
  let opts: Partial<SignKeyOptions> = {};
  if (isOptionsWrapper(key)) {
    opts = key;
    inner = key.key;
  }
  let ko: KeyObject;
  if (inner instanceof KeyObject) {
    ko = inner;
  } else if (purpose === "sign") {
    ko = createPrivateKey(inner as never);
  } else {
    ko = createPublicKey(inner as never);
  }
  let material = getKeyMaterial(ko);
  if (purpose === "verify") material = publicMaterial(material);
  return {
    material,
    padding: opts.padding,
    saltLength: opts.saltLength,
    dsaEncoding: opts.dsaEncoding,
  };
};

/** 'RSA-SHA256' | 'ecdsa-with-SHA384' | 'sha256' | null | 'ed25519' → hash name. */
const resolveSignAlgorithm = (algorithm: string | null | undefined): string | null => {
  if (algorithm === null || algorithm === undefined) return null;
  let a = algorithm.toLowerCase();
  if (a === "ed25519" || a === "ed448") return a;
  a = a.replace(/^rsa[-_]?/, "").replace(/^ecdsa[-_](with[-_])?/, "");
  lookupHash(a); // throws ERR_CRYPTO_INVALID_DIGEST on unknown names
  return a;
};

// ---- ECDSA DER ↔ IEEE-P1363 conversion ----

const derToP1363 = (der: Uint8Array, size: number): Uint8Array => {
  const node = parseDer(der);
  if (node.tag !== TAG.SEQUENCE || node.children.length !== 2) {
    throw Object.assign(new Error("Invalid DER signature"), {
      code: "ERR_CRYPTO_INVALID_SIGNATURE",
    });
  }
  const out = new Uint8Array(2 * size);
  out.set(bigIntToU8(derInt(node.children[0]), size), 0);
  out.set(bigIntToU8(derInt(node.children[1]), size), size);
  return out;
};

const p1363ToDer = (raw: Uint8Array): Uint8Array => {
  if (raw.length % 2 !== 0) {
    throw Object.assign(new Error("Invalid IEEE-P1363 signature length"), {
      code: "ERR_CRYPTO_INVALID_SIGNATURE",
    });
  }
  const half = raw.length / 2;
  return derSeq(
    derIntEncode(u8ToBigInt(raw.subarray(0, half))),
    derIntEncode(u8ToBigInt(raw.subarray(half))),
  );
};

// ---- one-shot ops ----

const unsupported = (what: string): Error =>
  Object.assign(new Error(`${what} is not supported by the browser crypto shim`), {
    code: "ERR_CRYPTO_UNSUPPORTED_OPERATION",
  });

const signBytes = (
  algorithm: string | null | undefined,
  data: Uint8Array,
  keyArg: KeyArg,
): Uint8Array => {
  const { material, padding, saltLength, dsaEncoding } = resolveKey(keyArg, "sign");
  const alg = resolveSignAlgorithm(algorithm);
  switch (material.kind) {
    case "rsa": {
      if (alg === null) {
        throw Object.assign(new Error("A digest algorithm is required for RSA signing"), {
          code: "ERR_CRYPTO_INVALID_DIGEST",
        });
      }
      const pad = padding ?? (material.pss ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING);
      if (pad !== RSA_PKCS1_PADDING && pad !== RSA_PKCS1_PSS_PADDING) {
        throw unsupported(`RSA padding mode ${pad}`);
      }
      const mHash = digestBytes(alg, data);
      const salt =
        saltLength ??
        (material.pss?.saltLength !== undefined ? material.pss.saltLength : undefined);
      return rsaSign(alg, mHash, material, pad, salt);
    }
    case "ec": {
      if (alg === null) {
        throw Object.assign(new Error("A digest algorithm is required for ECDSA signing"), {
          code: "ERR_CRYPTO_INVALID_DIGEST",
        });
      }
      if (!material.priv) {
        throw Object.assign(new Error("ECDSA signing requires a private key"), {
          code: "ERR_MISSING_PRIVATE_KEY",
        });
      }
      const mHash = digestBytes(alg, data);
      const der = nobleCurve(material.curve).sign(mHash, material.priv, {
        format: "der",
        prehash: false,
      }) as Uint8Array;
      return dsaEncoding === "ieee-p1363" ? derToP1363(der, ecCurveByteSize(material.curve)) : der;
    }
    case "okp": {
      if (material.curve !== "ed25519") throw unsupported(`${material.curve} signing`);
      if (alg !== null && alg !== "ed25519") {
        throw Object.assign(new Error("Ed25519 does not take a digest algorithm"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      }
      if (!material.priv) {
        throw Object.assign(new Error("Ed25519 signing requires a private key"), {
          code: "ERR_MISSING_PRIVATE_KEY",
        });
      }
      return ed25519.sign(data, material.priv);
    }
    case "cryptokey":
      throw unsupported("sign() with a wrapped CryptoKey");
    default:
      throw Object.assign(new TypeError("Key type does not support signing"), {
        code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
      });
  }
};

const verifyBytes = (
  algorithm: string | null | undefined,
  data: Uint8Array,
  keyArg: KeyArg,
  signature: Uint8Array,
): boolean => {
  const { material, padding, saltLength, dsaEncoding } = resolveKey(keyArg, "verify");
  const alg = resolveSignAlgorithm(algorithm);
  switch (material.kind) {
    case "rsa": {
      if (alg === null) {
        throw Object.assign(new Error("A digest algorithm is required for RSA verification"), {
          code: "ERR_CRYPTO_INVALID_DIGEST",
        });
      }
      const pad = padding ?? (material.pss ? RSA_PKCS1_PSS_PADDING : RSA_PKCS1_PADDING);
      const mHash = digestBytes(alg, data);
      return rsaVerify(alg, mHash, signature, material, pad, saltLength);
    }
    case "ec": {
      if (alg === null) {
        throw Object.assign(new Error("A digest algorithm is required for ECDSA verification"), {
          code: "ERR_CRYPTO_INVALID_DIGEST",
        });
      }
      if (!material.pub) return false;
      const mHash = digestBytes(alg, data);
      const der = dsaEncoding === "ieee-p1363" ? p1363ToDer(signature) : signature;
      try {
        return nobleCurve(material.curve).verify(der, mHash, material.pub, {
          format: "der",
          prehash: false,
        }) as boolean;
      } catch {
        return false;
      }
    }
    case "okp": {
      if (material.curve !== "ed25519") throw unsupported(`${material.curve} verification`);
      if (alg !== null && alg !== "ed25519") {
        throw Object.assign(new Error("Ed25519 does not take a digest algorithm"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      }
      try {
        return ed25519.verify(signature, data, material.pub);
      } catch {
        return false;
      }
    }
    case "cryptokey":
      throw unsupported("verify() with a wrapped CryptoKey");
    default:
      throw Object.assign(new TypeError("Key type does not support verification"), {
        code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
      });
  }
};

// ---- streaming facades ----

export class Sign {
  #algorithm: string | null | undefined;
  #chunks: Uint8Array[] = [];
  #done = false;

  constructor(algorithm?: string | null, _options?: unknown) {
    this.#algorithm = algorithm;
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    if (this.#done) throw new Error("Sign already finalized");
    this.#chunks.push(toU8(data, inputEncoding));
    return this;
  }

  sign(key: KeyArg): Buffer;
  sign(key: KeyArg, outputEncoding: BufferEncoding): string;
  sign(key: KeyArg, outputEncoding?: BufferEncoding): Buffer | string {
    this.#done = true;
    const out = signBytes(this.#algorithm, concatU8(this.#chunks), key);
    const buf = Buffer.from(out);
    return outputEncoding === undefined ? buf : buf.toString(outputEncoding);
  }
}

export class Verify {
  #algorithm: string | null | undefined;
  #chunks: Uint8Array[] = [];
  #done = false;

  constructor(algorithm?: string | null, _options?: unknown) {
    this.#algorithm = algorithm;
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    if (this.#done) throw new Error("Verify already finalized");
    this.#chunks.push(toU8(data, inputEncoding));
    return this;
  }

  verify(key: KeyArg, signature: BinaryLike, signatureEncoding?: BufferEncoding): boolean {
    this.#done = true;
    const sig = toU8(
      signature,
      signatureEncoding ?? (typeof signature === "string" ? "latin1" : undefined),
    );
    return verifyBytes(this.#algorithm, concatU8(this.#chunks), key, sig);
  }
}

export const createSign = (algorithm?: string | null, options?: unknown): Sign =>
  new Sign(algorithm, options);

export const createVerify = (algorithm?: string | null, options?: unknown): Verify =>
  new Verify(algorithm, options);

type SignCallback = (err: Error | null, signature: Buffer) => void;
type VerifyCallback = (err: Error | null, result: boolean) => void;

export const sign = (
  algorithm: string | null | undefined,
  data: BinaryLike,
  key: KeyArg,
  callback?: SignCallback,
): Buffer | void => {
  if (callback) {
    queueMicrotask(() => {
      try {
        callback(null, Buffer.from(signBytes(algorithm, toU8(data), key)));
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0));
      }
    });
    return;
  }
  return Buffer.from(signBytes(algorithm, toU8(data), key));
};

export const verify = (
  algorithm: string | null | undefined,
  data: BinaryLike,
  key: KeyArg,
  signature: BinaryLike,
  callback?: VerifyCallback,
): boolean | void => {
  if (callback) {
    queueMicrotask(() => {
      try {
        callback(null, verifyBytes(algorithm, toU8(data), key, toU8(signature)));
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)), false);
      }
    });
    return;
  }
  return verifyBytes(algorithm, toU8(data), key, toU8(signature));
};
