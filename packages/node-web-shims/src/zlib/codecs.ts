import { compress as brotliEncode, decompress as brotliDecode } from "brotli";
import {
  deflateSync as fflateDeflateSync,
  gunzipSync as fflateGunzipSync,
  gzipSync as fflateGzipSync,
  inflateSync as fflateInflateSync,
  unzlibSync,
  zlibSync,
} from "fflate";

import { Buffer, toU8, type BinaryLike } from "../internal/binary.js";

/** Node zlib option shorthands — fflate only needs `level` and `dictionary`. */
export interface ZlibOptions {
  flush?: number;
  finishFlush?: number;
  chunkSize?: number;
  windowBits?: number;
  level?: number;
  memLevel?: number;
  strategy?: number;
  dictionary?: BinaryLike;
  info?: boolean;
  maxOutputLength?: number;
  [key: string]: unknown;
}

export interface BrotliOptions extends ZlibOptions {
  params?: Record<number, number>;
}

type ZlibCallback = (err: Error | null, result: Buffer) => void;

const zlibError = (message: string, code = "ERR_INVALID_ARG_VALUE"): Error =>
  Object.assign(new Error(message), { code });

type FflateLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

interface CompressOpts {
  level?: FflateLevel;
  dictionary?: Uint8Array;
}

const toCompressOpts = (opts?: ZlibOptions): CompressOpts => {
  const out: CompressOpts = {};
  if (opts?.level !== undefined) out.level = opts.level as FflateLevel;
  if (opts?.dictionary !== undefined) out.dictionary = toU8(opts.dictionary);
  return out;
};

// fflate's `out` is a caller-allocated output buffer — map node's
// maxOutputLength to a bounded buffer when provided.
const toDecompressOpts = (opts?: ZlibOptions): { out?: Uint8Array } =>
  opts?.maxOutputLength !== undefined ? { out: new Uint8Array(opts.maxOutputLength) } : {};

const wrapResult = (
  result: Uint8Array,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } => {
  const buf = Buffer.from(result.buffer, result.byteOffset, result.length);
  return opts?.info ? { engine: buf, buffer: buf } : buf;
};

const codec =
  (fn: (data: Uint8Array, opts?: ZlibOptions) => Buffer | { engine: Buffer; buffer: Buffer }) =>
  (
    data: BinaryLike,
    optsOrCb?: ZlibOptions | BrotliOptions | ZlibCallback,
    cb?: ZlibCallback,
  ): void => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as ZlibCallback;
    if (typeof callback !== "function") {
      throw new TypeError("A callback is required");
    }
    const opts = typeof optsOrCb === "function" ? undefined : optsOrCb;
    queueMicrotask(() => {
      try {
        callback(null, fn(toU8(data), opts) as Buffer);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0));
      }
    });
  };

// ---- deflate / inflate (zlib-wrapped, raw, gzip) ----

export const deflateSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(zlibSync(toU8(data), toCompressOpts(opts)), opts);

export const inflateSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(unzlibSync(toU8(data), toDecompressOpts(opts)), opts);

export const deflateRawSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(fflateDeflateSync(toU8(data), toCompressOpts(opts)), opts);

export const inflateRawSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(fflateInflateSync(toU8(data), toDecompressOpts(opts)), opts);

export const gzipSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(fflateGzipSync(toU8(data), toCompressOpts(opts)), opts);

export const gunzipSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  wrapResult(fflateGunzipSync(toU8(data), toDecompressOpts(opts)), opts);

const isGzip = (d: Uint8Array): boolean => d.length > 2 && d[0] === 0x1f && d[1] === 0x8b;
const isZlib = (d: Uint8Array): boolean =>
  d.length > 2 && (d[0] & 0x0f) === 8 && ((d[0] << 8) | d[1]) % 31 === 0;

export const unzipSync = (
  data: BinaryLike,
  opts?: ZlibOptions,
): Buffer | { engine: Buffer; buffer: Buffer } => {
  const d = toU8(data);
  try {
    if (isGzip(d)) return wrapResult(fflateGunzipSync(d, toDecompressOpts(opts)), opts);
    if (isZlib(d)) return wrapResult(unzlibSync(d, toDecompressOpts(opts)), opts);
    return wrapResult(fflateInflateSync(d, toDecompressOpts(opts)), opts);
  } catch (err) {
    throw zlibError(err instanceof Error ? err.message : String(err), "Z_DATA_ERROR");
  }
};

export const deflate = codec(deflateSync);
export const inflate = codec(inflateSync);
export const deflateRaw = codec(deflateRawSync);
export const inflateRaw = codec(inflateRawSync);
export const gzip = codec(gzipSync);
export const gunzip = codec(gunzipSync);
export const unzip = codec(unzipSync);

// ---- Brotli ----

/**
 * Emit a valid Brotli stream using uncompressed meta-blocks (RFC 7932 §9.2).
 * Real Brotli compression would need a WASM/port — the `brotli` package's
 * encoder is async-only — so sync `brotliCompress` emits stored blocks, which
 * every conforming Brotli decoder (including `node:zlib`) can read.
 */
const brotliStore = (input: Uint8Array): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const bitBuf: number[] = [];
  let bitPos = 0;
  const pushBits = (value: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      if (bitPos === 0) bitBuf.push(0);
      if ((value >>> i) & 1) bitBuf[bitBuf.length - 1] |= 1 << bitPos;
      bitPos = (bitPos + 1) & 7;
    }
  };
  const flushBits = (): void => {
    chunks.push(new Uint8Array(bitBuf));
    bitBuf.length = 0;
    bitPos = 0;
  };
  // WBITS: single 0 bit → window size 16.
  pushBits(0, 1);
  for (let off = 0; off < input.length; off += 65536) {
    const block = input.subarray(off, Math.min(off + 65536, input.length));
    // Uncompressed meta-blocks are only legal when ISLAST = 0 (RFC 7932
    // §9.2); the stream then terminates with an empty last block.
    pushBits(0, 1); // ISLAST = 0
    pushBits(0, 2); // MNIBBLES = 0 → 4 nibbles
    pushBits(block.length - 1, 16); // MLEN - 1
    pushBits(1, 1); // ISUNCOMPRESSED
    flushBits(); // byte-align (pads current partial byte with zeros)
    chunks.push(block);
  }
  pushBits(1, 1); // ISLAST
  pushBits(1, 1); // ISLASTEMPTY
  flushBits();
  return chunks.length === 1
    ? chunks[0]
    : (() => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        return out;
      })();
};

export const brotliCompressSync = (
  data: BinaryLike,
  opts?: BrotliOptions,
): Buffer | { engine: Buffer; buffer: Buffer } =>
  // quality/sizeHint params accepted for API compatibility; stored blocks
  // have no tuning knobs.
  wrapResult(brotliStore(toU8(data)), opts);

export const brotliDecompressSync = (
  data: BinaryLike,
  opts?: BrotliOptions,
): Buffer | { engine: Buffer; buffer: Buffer } => {
  try {
    return wrapResult(brotliDecode(toU8(data)), opts);
  } catch (err) {
    throw zlibError(err instanceof Error ? err.message : String(err), "Z_DATA_ERROR");
  }
};

// Brotli param ids (duplicated in zlib.ts as named exports).
const BROTLI_PARAM_MODE = 0;
const BROTLI_PARAM_QUALITY = 1;
const BROTLI_PARAM_LGWIN = 2;

/**
 * Async `brotliCompress` — uses the `brotli` package's real WASM encoder
 * (stored-block output is reserved for the sync variant, which cannot await).
 * Falls back to stored blocks if the WASM encoder fails to initialize.
 */
export const brotliCompress = (
  data: BinaryLike,
  optsOrCb?: BrotliOptions | ZlibCallback,
  cb?: ZlibCallback,
): void => {
  const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as ZlibCallback;
  if (typeof callback !== "function") {
    throw new TypeError("A callback is required");
  }
  const opts = (typeof optsOrCb === "function" ? undefined : optsOrCb) as BrotliOptions | undefined;
  const params = opts?.params ?? {};
  const input = toU8(data);
  brotliEncode(input, {
    quality: params[BROTLI_PARAM_QUALITY],
    lgwin: params[BROTLI_PARAM_LGWIN],
    mode: params[BROTLI_PARAM_MODE] as 0 | 1 | 2 | undefined,
    dictionary: opts?.dictionary !== undefined ? toU8(opts.dictionary) : undefined,
  }).then(
    (out) =>
      queueMicrotask(() => {
        if (out) {
          callback(null, wrapResult(out, opts) as Buffer);
        } else {
          callback(zlibError("brotliCompress failed", "Z_DATA_ERROR"), Buffer.alloc(0));
        }
      }),
    // WASM init/compile failure → degrade to stored blocks rather than error.
    () => queueMicrotask(() => callback(null, wrapResult(brotliStore(input), opts) as Buffer)),
  );
};
export const brotliDecompress = codec(brotliDecompressSync);

// ---- crc32 (node:zlib ≥20.15) ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export const crc32 = (data: BinaryLike, value = 0): number => {
  let crc = ~value;
  const d = toU8(data);
  for (let i = 0; i < d.length; i++) crc = CRC_TABLE[(crc ^ d[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
};
