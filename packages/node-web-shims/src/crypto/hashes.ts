import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from "@noble/hashes/sha2.js";
import { sha3_224, sha3_256, sha3_384, sha3_512, shake128, shake256 } from "@noble/hashes/sha3.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";

import { Buffer, concatU8, toU8, type BinaryLike } from "../internal/binary.js";

/**
 * noble v2 types hash functions as `TRet` — sync-or-async depending on the
 * input. The shim only ever feeds `Uint8Array`, so results are always sync;
 * these local types express that without casts at every call site.
 */
export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digest(): Uint8Array;
  destroy(): void;
}

export type HashFn = {
  (msg: Uint8Array): Uint8Array;
  create(): IncrementalHash;
  outputLen: number;
};

type XofFn = (msg: Uint8Array, opts: { dkLen: number }) => Uint8Array;

export const asHashFn = (h: unknown): HashFn => h as HashFn;
const asXofFn = (h: unknown): XofFn => h as XofFn;

interface HashEntry {
  /** Fixed-length digest; undefined for XOFs. */
  hash?: HashFn;
  /** Extendable-output variant — requires a `dkLen` at digest time. */
  xof?: XofFn;
  /** Output size in bytes (default for XOFs). */
  size: number;
}

// Node accepts OpenSSL-style names: 'sha256', 'SHA256', 'sha-256', 'SHA-256',
// 'rmd160', 'ripemd-160'. 'RSA-SHA256'-style prefixes are handled by
// sign/verify, not here.
export const normalizeHashName = (algorithm: string): string =>
  algorithm.toLowerCase().replace(/-/g, "");

const HASHES: Record<string, HashEntry> = {
  md5: { hash: asHashFn(md5), size: 16 },
  ripemd160: { hash: asHashFn(ripemd160), size: 20 },
  rmd160: { hash: asHashFn(ripemd160), size: 20 },
  sha1: { hash: asHashFn(sha1), size: 20 },
  sha224: { hash: asHashFn(sha224), size: 28 },
  sha256: { hash: asHashFn(sha256), size: 32 },
  sha384: { hash: asHashFn(sha384), size: 48 },
  sha512: { hash: asHashFn(sha512), size: 64 },
  sha512224: { hash: asHashFn(sha512_224), size: 28 },
  sha512256: { hash: asHashFn(sha512_256), size: 32 },
  sha3224: { hash: asHashFn(sha3_224), size: 28 },
  sha3256: { hash: asHashFn(sha3_256), size: 32 },
  sha3384: { hash: asHashFn(sha3_384), size: 48 },
  sha3512: { hash: asHashFn(sha3_512), size: 64 },
  shake128: { xof: asXofFn(shake128), size: 16 },
  shake256: { xof: asXofFn(shake256), size: 32 },
};

export const lookupHash = (algorithm: string): HashEntry => {
  const entry = HASHES[normalizeHashName(algorithm)];
  if (!entry) {
    throw Object.assign(new Error(`Digest method not supported: "${algorithm}"`), {
      code: "ERR_CRYPTO_INVALID_DIGEST",
    });
  }
  return entry;
};

export const getHashes = (): string[] => Object.keys(HASHES);

/** Digest size in bytes for a fixed-length algorithm (default for XOFs). */
export const digestSize = (algorithm: string): number => lookupHash(algorithm).size;

/** One-shot digest. Backs `crypto.hash` and the sign/kdf internals. */
export const digestBytes = (
  algorithm: string,
  data: Uint8Array,
  outputLength?: number,
): Uint8Array => {
  const entry = lookupHash(algorithm);
  if (entry.xof) {
    const len = outputLength ?? entry.size;
    if (!Number.isInteger(len) || len <= 0) {
      throw Object.assign(
        new Error(`Output length must be a positive integer for "${algorithm}"`),
        { code: "ERR_OUT_OF_RANGE" },
      );
    }
    return entry.xof(data, { dkLen: len });
  }
  if (!entry.hash) throw new Error(`unreachable: ${algorithm}`);
  return entry.hash(data);
};

export interface HashOptions {
  outputLength?: number;
}

/**
 * `crypto.Hash` — streaming digest over a pure-JS hash. Not a real
 * `stream.Transform` (unenv's streams are non-functional); exposes Node's
 * imperative surface — `update`, `digest`, `copy` — plus minimal
 * `write`/`end`/`read` sugar.
 */
export class Hash {
  #algorithm: string;
  #outputLength: number | undefined;
  #chunks: Uint8Array[] = [];
  #finalized = false;

  constructor(algorithm: string, options?: HashOptions) {
    lookupHash(algorithm); // validate eagerly like Node
    this.#algorithm = algorithm;
    this.#outputLength = options?.outputLength;
  }

  #assertLive(): void {
    if (this.#finalized) {
      throw Object.assign(new Error("Digest already called"), {
        code: "ERR_CRYPTO_HASH_FINALIZED",
      });
    }
  }

  update(data: BinaryLike, inputEncoding?: BufferEncoding): this {
    this.#assertLive();
    this.#chunks.push(toU8(data, inputEncoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: BufferEncoding): Buffer | string {
    this.#assertLive();
    this.#finalized = true;
    const entry = lookupHash(this.#algorithm);
    const chunks = this.#chunks;
    this.#chunks = [];
    const out = entry.xof
      ? entry.xof(concatU8(chunks), {
          dkLen: this.#outputLength ?? entry.size,
        })
      : hashChunks(entry.hash!, chunks);
    const buf = Buffer.from(out);
    return encoding === undefined ? buf : buf.toString(encoding);
  }

  copy(options?: HashOptions): Hash {
    this.#assertLive();
    const copy = new Hash(this.#algorithm, {
      outputLength: options?.outputLength ?? this.#outputLength,
    });
    copy.#chunks = [...this.#chunks];
    return copy;
  }

  // Minimal stream sugar so `hash.write(d); hash.end(); hash.read()`-shaped
  // code paths work without a real Transform underneath.
  write(chunk: BinaryLike, encoding?: BufferEncoding): boolean {
    this.update(chunk, encoding);
    return true;
  }

  end(chunk?: BinaryLike, encoding?: BufferEncoding): void {
    if (chunk !== undefined) this.update(chunk, encoding);
  }

  read(): Buffer | null {
    try {
      return this.digest();
    } catch {
      return null;
    }
  }
}

const hashChunks = (hash: HashFn, chunks: Uint8Array[]): Uint8Array => {
  const hasher = hash.create();
  for (const c of chunks) hasher.update(c);
  const out = hasher.digest();
  hasher.destroy();
  return out;
};

export const createHash = (algorithm: string, options?: HashOptions): Hash =>
  new Hash(algorithm, options);

/** `crypto.hash` — one-shot digest (Node 21.2+). */
export const hash = (
  algorithm: string,
  data: BinaryLike,
  outputEncoding?: BufferEncoding | "buffer",
): Buffer | string => {
  const out = digestBytes(algorithm, toU8(data));
  const buf = Buffer.from(out);
  if (outputEncoding === undefined || outputEncoding === "buffer") return buf;
  return buf.toString(outputEncoding);
};
