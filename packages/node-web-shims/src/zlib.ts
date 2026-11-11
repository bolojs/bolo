import unenvZlib from "unenv/node/zlib";

import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  crc32,
  deflate,
  deflateRaw,
  deflateRawSync,
  deflateSync,
  gunzip,
  gunzipSync,
  gzip,
  gzipSync,
  inflate,
  inflateRaw,
  inflateRawSync,
  inflateSync,
  unzip,
  unzipSync,
} from "./zlib/codecs.js";
import {
  BrotliCompress,
  BrotliDecompress,
  Deflate,
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
  ZlibBase,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
} from "./zlib/streams.js";
import {
  ZstdCompress,
  ZstdDecompress,
  createZstdCompress,
  createZstdDecompress,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
} from "./zlib/zstd.js";

const unenv = unenvZlib as unknown as Record<string, unknown>;

/**
 * Zstandard constants (values from zstd.h — Node mirrors them verbatim).
 * unenv predates Node's zstd support, so they are merged into `constants`
 * here rather than spread from it.
 */
const ZSTD_CONSTANTS = {
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_fast: 1,
  ZSTD_dfast: 2,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_hashLog: 102,
  ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105,
  ZSTD_c_targetLength: 106,
  ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401,
  ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100,
  ZSTD_error_no_error: 0,
  ZSTD_error_GENERIC: 1,
  ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12,
  ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16,
  ZSTD_error_corruption_detected: 20,
  ZSTD_error_checksum_wrong: 22,
  ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60,
  ZSTD_error_init_missing: 62,
  ZSTD_error_memory_allocation: 64,
  ZSTD_error_workSpace_tooSmall: 66,
  ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_dstBuffer_null: 74,
  ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82,
} as const;

export const constants = {
  ...(unenv.constants as Record<string, unknown>),
  ...ZSTD_CONSTANTS,
};

/**
 * `node:zlib` — fflate supplies deflate/inflate/gzip/gunzip (sync + streams),
 * the `brotli` npm package decodes Brotli while a compact stored-block
 * encoder produces valid Brotli output synchronously (async `brotliCompress`
 * uses the package's real WASM encoder), and zstd runs through the platform
 * `CompressionStream`/`DecompressionStream`. The unenv spread keeps `codes`
 * and the `Z_*` constants.
 */
const zlib = {
  ...unenvZlib,

  constants,
  crc32,

  deflate,
  deflateSync,
  inflate,
  inflateSync,
  deflateRaw,
  deflateRawSync,
  inflateRaw,
  inflateRawSync,
  gzip,
  gzipSync,
  gunzip,
  gunzipSync,
  unzip,
  unzipSync,

  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,

  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Gzip,
  Gunzip,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZlibBase,

  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createGzip,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,

  ZstdCompress,
  ZstdDecompress,
  createZstdCompress,
  createZstdDecompress,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};

/** Creates a node:zlib shim — `fs.createReadStream().pipe(createGunzip())` etc. */
export const createZlibShim = (): typeof zlib => {
  return zlib;
};

// Named exports — every key is enumerable for the `Object.keys` namespace
// re-export in wasm-registry/live.ts.
export {
  crc32,
  deflate,
  deflateSync,
  inflate,
  inflateSync,
  deflateRaw,
  deflateRawSync,
  inflateRaw,
  inflateRawSync,
  gzip,
  gzipSync,
  gunzip,
  gunzipSync,
  unzip,
  unzipSync,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  Deflate,
  Inflate,
  DeflateRaw,
  InflateRaw,
  Gzip,
  Gunzip,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZlibBase,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createGzip,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  ZstdCompress,
  ZstdDecompress,
  createZstdCompress,
  createZstdDecompress,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};

export const codes = unenv.codes;
export const Z_NO_FLUSH = unenv.Z_NO_FLUSH;
export const Z_PARTIAL_FLUSH = unenv.Z_PARTIAL_FLUSH;
export const Z_SYNC_FLUSH = unenv.Z_SYNC_FLUSH;
export const Z_FULL_FLUSH = unenv.Z_FULL_FLUSH;
export const Z_FINISH = unenv.Z_FINISH;
export const Z_BLOCK = unenv.Z_BLOCK;
export const Z_OK = unenv.Z_OK;
export const Z_STREAM_END = unenv.Z_STREAM_END;
export const Z_NEED_DICT = unenv.Z_NEED_DICT;
export const Z_ERRNO = unenv.Z_ERRNO;
export const Z_STREAM_ERROR = unenv.Z_STREAM_ERROR;
export const Z_DATA_ERROR = unenv.Z_DATA_ERROR;
export const Z_MEM_ERROR = unenv.Z_MEM_ERROR;
export const Z_BUF_ERROR = unenv.Z_BUF_ERROR;
export const Z_VERSION_ERROR = unenv.Z_VERSION_ERROR;
export const Z_NO_COMPRESSION = unenv.Z_NO_COMPRESSION;
export const Z_BEST_SPEED = unenv.Z_BEST_SPEED;
export const Z_BEST_COMPRESSION = unenv.Z_BEST_COMPRESSION;
export const Z_DEFAULT_COMPRESSION = unenv.Z_DEFAULT_COMPRESSION;
export const Z_FILTERED = unenv.Z_FILTERED;
export const Z_HUFFMAN_ONLY = unenv.Z_HUFFMAN_ONLY;
export const Z_RLE = unenv.Z_RLE;
export const Z_FIXED = unenv.Z_FIXED;
export const Z_DEFAULT_STRATEGY = unenv.Z_DEFAULT_STRATEGY;
export const ZLIB_VERNUM = unenv.ZLIB_VERNUM;
export const Z_MIN_WINDOWBITS = unenv.Z_MIN_WINDOWBITS;
export const Z_MAX_WINDOWBITS = unenv.Z_MAX_WINDOWBITS;
export const Z_DEFAULT_WINDOWBITS = unenv.Z_DEFAULT_WINDOWBITS;
export const Z_MIN_CHUNK = unenv.Z_MIN_CHUNK;
export const Z_MAX_CHUNK = unenv.Z_MAX_CHUNK;
export const Z_DEFAULT_CHUNK = unenv.Z_DEFAULT_CHUNK;
export const Z_MIN_MEMLEVEL = unenv.Z_MIN_MEMLEVEL;
export const Z_MAX_MEMLEVEL = unenv.Z_MAX_MEMLEVEL;
export const Z_DEFAULT_MEMLEVEL = unenv.Z_DEFAULT_MEMLEVEL;
export const Z_MIN_LEVEL = unenv.Z_MIN_LEVEL;
export const Z_MAX_LEVEL = unenv.Z_MAX_LEVEL;
export const Z_DEFAULT_LEVEL = unenv.Z_DEFAULT_LEVEL;
export const Z_BEST_LEVEL = unenv.Z_BEST_LEVEL ?? unenv.Z_BEST_COMPRESSION;
export const DEFLATE = unenv.DEFLATE;
export const INFLATE = unenv.INFLATE;
export const GZIP = unenv.GZIP;
export const GUNZIP = unenv.GUNZIP;
export const DEFLATERAW = unenv.DEFLATERAW;
export const INFLATERAW = unenv.INFLATERAW;
export const UNZIP = unenv.UNZIP;

// ---- Brotli operation/param constants (node:zlib values; unenv omits them) ----
export const BROTLI_DECODE = 8;
export const BROTLI_ENCODE = 9;
export const BROTLI_OPERATION_PROCESS = 0;
export const BROTLI_OPERATION_FLUSH = 1;
export const BROTLI_OPERATION_FINISH = 2;
export const BROTLI_OPERATION_EMIT_METADATA = 3;
export const BROTLI_PARAM_MODE = 0;
export const BROTLI_PARAM_QUALITY = 1;
export const BROTLI_PARAM_LGWIN = 2;
export const BROTLI_PARAM_LGBLOCK = 3;
export const BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING = 4;
export const BROTLI_PARAM_SIZE_HINT = 5;
export const BROTLI_PARAM_LARGE_WINDOW = 6;
export const BROTLI_PARAM_NPOSTFIX = 7;
export const BROTLI_PARAM_NDIRECT = 8;
export const BROTLI_MODE_GENERIC = 0;
export const BROTLI_MODE_TEXT = 1;
export const BROTLI_MODE_FONT = 2;
export const BROTLI_DEFAULT_MODE = 0;
export const BROTLI_MIN_QUALITY = 0;
export const BROTLI_MAX_QUALITY = 11;
export const BROTLI_DEFAULT_QUALITY = 11;
export const BROTLI_MIN_WINDOW_BITS = 10;
export const BROTLI_MAX_WINDOW_BITS = 24;
export const BROTLI_LARGE_MAX_WINDOW_BITS = 30;
export const BROTLI_DEFAULT_WINDOW = 22;
export const BROTLI_MIN_INPUT_BLOCK_BITS = 16;
export const BROTLI_MAX_INPUT_BLOCK_BITS = 24;
export const BROTLI_DECODER_RESULT_ERROR = 0;
export const BROTLI_DECODER_RESULT_SUCCESS = 1;
export const BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT = 2;
export const BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT = 3;
export const BROTLI_DECODER_NO_ERROR = 0;
export const BROTLI_DECODER_SUCCESS = 1;
export const BROTLI_DECODER_NEEDS_MORE_INPUT = 2;
export const BROTLI_DECODER_NEEDS_MORE_OUTPUT = 3;

export default zlib;
