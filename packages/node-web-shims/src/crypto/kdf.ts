import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2 as noblePbkdf2 } from "@noble/hashes/pbkdf2.js";
import { scrypt as nobleScrypt, scryptAsync } from "@noble/hashes/scrypt.js";
import type { CHash } from "@noble/hashes/utils.js";

import { Buffer, toU8, type BinaryLike } from "../internal/binary.js";
import { lookupHash, normalizeHashName } from "./hashes.js";
import { KeyObject, getKeyMaterial } from "./keys.js";

type KdfInput = BinaryLike | KeyObject;

const toKdfBytes = (input: KdfInput): Uint8Array => {
  if (input instanceof KeyObject) {
    const material = getKeyMaterial(input);
    if (material.kind !== "secret") {
      throw Object.assign(new TypeError("Key must be of type 'secret'"), {
        code: "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
      });
    }
    return material.bytes;
  }
  return toU8(input);
};

const nextTick = (fn: () => void): void => {
  queueMicrotask(fn);
};

// ---- pbkdf2 ----

const WEBCRYPTO_PBKDF2 = new Set(["sha1", "sha256", "sha384", "sha512"]);

export const pbkdf2Sync = (
  password: KdfInput,
  salt: KdfInput,
  iterations: number,
  keylen: number,
  digest = "sha1",
): Buffer => {
  const entry = lookupHash(digest);
  if (entry.xof || !entry.hash) {
    throw Object.assign(new Error(`PBKDF2 does not support digest "${digest}"`), {
      code: "ERR_CRYPTO_INVALID_DIGEST",
    });
  }
  const out = noblePbkdf2(entry.hash as unknown as CHash, toKdfBytes(password), toKdfBytes(salt), {
    c: iterations,
    dkLen: keylen,
  }) as Uint8Array;
  return Buffer.from(out);
};

export const pbkdf2 = (
  password: KdfInput,
  salt: KdfInput,
  iterations: number,
  keylen: number,
  digest: string | null | undefined,
  callback: (err: Error | null, derivedKey: Buffer) => void,
): void => {
  const digestName = digest ?? "sha1";
  const run = async (): Promise<Uint8Array> => {
    const normalized = normalizeHashName(digestName);
    const subtle = globalThis.crypto?.subtle;
    if (subtle && WEBCRYPTO_PBKDF2.has(normalized)) {
      const webAlg = normalized === "sha1" ? "SHA-1" : `SHA-${normalized.slice(3)}`;
      const baseKey = await subtle.importKey(
        "raw",
        toU8(toKdfBytes(password)) as BufferSource,
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      const bits = await subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: webAlg,
          salt: toU8(toKdfBytes(salt)) as BufferSource,
          iterations,
        },
        baseKey,
        keylen * 8,
      );
      return new Uint8Array(bits);
    }
    return pbkdf2Sync(password, salt, iterations, keylen, digestName);
  };
  run().then(
    (out) => nextTick(() => callback(null, Buffer.from(out))),
    (err) =>
      nextTick(() =>
        callback(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0)),
      ),
  );
};

// ---- scrypt ----

export interface ScryptOptions {
  /** Alias for `N` (Node uses `cost`). */
  cost?: number;
  N?: number;
  /** Alias for `r` (Node uses `blockSize`). */
  blockSize?: number;
  r?: number;
  /** Alias for `p` (Node uses `parallelization`). */
  parallelization?: number;
  p?: number;
  maxmem?: number;
}

const scryptParams = (
  keylen: number,
  options?: ScryptOptions,
): { N: number; r: number; p: number; dkLen: number; maxmem?: number } => {
  const N = options?.N ?? options?.cost ?? 16384;
  const r = options?.r ?? options?.blockSize ?? 8;
  const p = options?.p ?? options?.parallelization ?? 1;
  const maxmem = options?.maxmem ?? Math.max(32 * 1024 * 1024, 128 * N * r * 2);
  return { N, r, p, dkLen: keylen, maxmem };
};

export const scryptSync = (
  password: KdfInput,
  salt: KdfInput,
  keylen: number,
  options?: ScryptOptions,
): Buffer => {
  const out = nobleScrypt(
    toKdfBytes(password),
    toKdfBytes(salt),
    scryptParams(keylen, options),
  ) as Uint8Array;
  return Buffer.from(out);
};

export const scrypt = (
  password: KdfInput,
  salt: KdfInput,
  keylen: number,
  options: ScryptOptions | ((err: Error | null, derivedKey: Buffer) => void) | undefined,
  callback?: (err: Error | null, derivedKey: Buffer) => void,
): void => {
  const opts = typeof options === "function" ? undefined : options;
  const cb = typeof options === "function" ? options : callback;
  if (!cb) {
    throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  nobleScryptAsync(toKdfBytes(password), toKdfBytes(salt), keylen, opts).then(
    (out) => nextTick(() => cb(null, Buffer.from(out))),
    (err) =>
      nextTick(() => cb(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0))),
  );
};

const nobleScryptAsync = (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options?: ScryptOptions,
): Promise<Uint8Array> =>
  scryptAsync(password, salt, scryptParams(keylen, options)) as Promise<Uint8Array>;

// ---- hkdf ----

const WEBCRYPTO_HKDF = WEBCRYPTO_PBKDF2;

export const hkdfSync = (
  digest: string,
  ikm: KdfInput,
  salt: KdfInput,
  info: KdfInput,
  keylen: number,
): ArrayBuffer => {
  const entry = lookupHash(digest);
  if (entry.xof || !entry.hash) {
    throw Object.assign(new Error(`HKDF does not support digest "${digest}"`), {
      code: "ERR_CRYPTO_INVALID_DIGEST",
    });
  }
  const out = nobleHkdf(
    entry.hash as unknown as CHash,
    toKdfBytes(ikm),
    toKdfBytes(salt),
    toKdfBytes(info),
    keylen,
  ) as Uint8Array;
  // Node returns an ArrayBuffer, not a Buffer.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
};

export const hkdf = (
  digest: string,
  ikm: KdfInput,
  salt: KdfInput,
  info: KdfInput,
  keylen: number,
  callback: (err: Error | null, derivedKey: ArrayBuffer) => void,
): void => {
  const run = async (): Promise<ArrayBuffer> => {
    const normalized = normalizeHashName(digest);
    const subtle = globalThis.crypto?.subtle;
    if (subtle && WEBCRYPTO_HKDF.has(normalized)) {
      const webAlg = normalized === "sha1" ? "SHA-1" : `SHA-${normalized.slice(3)}`;
      const baseKey = await subtle.importKey(
        "raw",
        toU8(toKdfBytes(ikm)) as BufferSource,
        "HKDF",
        false,
        ["deriveBits"],
      );
      return subtle.deriveBits(
        {
          name: "HKDF",
          hash: webAlg,
          salt: toU8(toKdfBytes(salt)) as BufferSource,
          info: toU8(toKdfBytes(info)) as BufferSource,
        },
        baseKey,
        keylen * 8,
      );
    }
    return hkdfSync(digest, ikm, salt, info, keylen);
  };
  run().then(
    (out) => nextTick(() => callback(null, out)),
    (err) =>
      nextTick(() =>
        callback(err instanceof Error ? err : new Error(String(err)), new ArrayBuffer(0)),
      ),
  );
};
