import { Buffer, concatU8, toU8, type BinaryLike } from "../internal/binary.js";
import type { ZlibOptions } from "./codecs.js";
import { ZlibBase } from "./streams.js";

/**
 * `node:zlib` zstd surface (Node ≥22.15). There is no synchronous pure-JS
 * zstd codec in the dependency tree, so the streams and async one-shots run
 * through the platform `CompressionStream`/`DecompressionStream` ("zstd" —
 * Chromium), while the `*Sync` variants throw a descriptive error. This is
 * the surface undici reaches for when decompressing `content-encoding: zstd`
 * responses.
 */

export interface ZstdOptions extends ZlibOptions {
  /** Accepted for API parity; the platform codec derives it. */
  pledgedSrcSize?: number;
  /** ZSTD_* parameter map; unsupported on the web codec. */
  params?: Record<number, number>;
}

type ZstdCallback = (err: Error | null, result: Buffer) => void;

const zstdError = (what: string, cause?: unknown): Error =>
  Object.assign(
    new Error(
      `zlib.${what}: zstd codec unavailable` +
        (cause === undefined ? "" : ` — ${cause instanceof Error ? cause.message : String(cause)}`),
    ),
    { code: "ERR_ZSTD_UNAVAILABLE", cause },
  );

type TransformCtor = new (format: string) => TransformStream<Uint8Array, Uint8Array>;

const codecCtor = (compress: boolean): TransformCtor => {
  const Ctor = (compress ? globalThis.CompressionStream : globalThis.DecompressionStream) as
    | TransformCtor
    | undefined;
  if (typeof Ctor !== "function") {
    throw zstdError(
      compress ? "zstdCompress" : "zstdDecompress",
      "CompressionStream/DecompressionStream is not present",
    );
  }
  return Ctor;
};

const zstdTransform = async (data: Uint8Array, compress: boolean): Promise<Uint8Array> => {
  const what = compress ? "zstdCompress" : "zstdDecompress";
  let transform: TransformStream<Uint8Array, Uint8Array>;
  try {
    transform = new (codecCtor(compress))("zstd");
  } catch (err) {
    throw zstdError(what, err);
  }
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
  } catch (err) {
    throw zstdError(what, err);
  }
};

// ---- streams (buffered — the platform codec is one-shot) ----

export class ZstdCompress extends ZlibBase {
  constructor(_options?: ZstdOptions) {
    super(null, (chunks) => zstdTransform(concatU8(chunks), true));
  }
}

export class ZstdDecompress extends ZlibBase {
  constructor(_options?: ZstdOptions) {
    super(null, (chunks) => zstdTransform(concatU8(chunks), false));
  }
}

export const createZstdCompress = (options?: ZstdOptions): ZstdCompress =>
  new ZstdCompress(options);

export const createZstdDecompress = (options?: ZstdOptions): ZstdDecompress =>
  new ZstdDecompress(options);

// ---- one-shots ----

const oneShot =
  (compress: boolean) =>
  (data: BinaryLike, optsOrCb?: ZstdOptions | ZstdCallback, cb?: ZstdCallback): void => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as ZstdCallback | undefined;
    if (typeof callback !== "function") {
      throw new TypeError("A callback is required");
    }
    zstdTransform(toU8(data), compress).then(
      (out) =>
        queueMicrotask(() => callback(null, Buffer.from(out.buffer, out.byteOffset, out.length))),
      (err) =>
        queueMicrotask(() =>
          callback(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0)),
        ),
    );
  };

export const zstdCompress = oneShot(true);
export const zstdDecompress = oneShot(false);

export const zstdCompressSync = (_data: BinaryLike, _opts?: ZstdOptions): never => {
  throw zstdError(
    "zstdCompressSync",
    "no synchronous zstd codec; use zstdCompress or createZstdCompress",
  );
};

export const zstdDecompressSync = (_data: BinaryLike, _opts?: ZstdOptions): never => {
  throw zstdError(
    "zstdDecompressSync",
    "no synchronous zstd codec; use zstdDecompress or createZstdDecompress",
  );
};
