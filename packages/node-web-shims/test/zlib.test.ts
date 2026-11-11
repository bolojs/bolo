import nodeZlib from "node:zlib";
import { describe, it, expect } from "vitest";
import { createZlibShim } from "../src/zlib.ts";

const z = createZlibShim();
const DATA = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(8));

const collect = (
  s: { on(e: string, l: (...a: never[]) => void): unknown; write(d: Buffer): unknown; end(d?: Buffer): unknown },
  writes: Buffer[],
): Promise<Buffer> =>
  new Promise<Buffer>((res, rej) => {
    const chunks: Buffer[] = [];
    s.on("data", ((d: Buffer) => chunks.push(d)) as never);
    s.on("end", (() => res(Buffer.concat(chunks))) as never);
    s.on("error", ((e: Error) => rej(e)) as never);
    for (const w of writes.slice(0, -1)) s.write(w);
    s.end(writes[writes.length - 1]);
  });

describe("node-web-shims: zlib", () => {
  it("exports the full surface", () => {
    for (const name of [
      "deflate", "deflateSync", "inflate", "inflateSync",
      "deflateRaw", "deflateRawSync", "inflateRaw", "inflateRawSync",
      "gzip", "gzipSync", "gunzip", "gunzipSync", "unzip", "unzipSync",
      "brotliCompress", "brotliCompressSync", "brotliDecompress", "brotliDecompressSync",
      "createDeflate", "createInflate", "createDeflateRaw", "createInflateRaw",
      "createGzip", "createGunzip", "createUnzip",
      "createBrotliCompress", "createBrotliDecompress",
      "Deflate", "Inflate", "Gzip", "Gunzip", "Unzip",
      "BrotliCompress", "BrotliDecompress", "crc32", "constants", "codes",
    ]) {
      expect(Object.keys(z), name).toContain(name);
      expect(z[name as keyof typeof z], name).toBeDefined();
    }
  });
});

describe("sync codecs", () => {
  it("gzipSync/gunzipSync round-trip, both directions vs node:zlib", () => {
    // ours → node
    expect(nodeZlib.gunzipSync(z.gzipSync(DATA) as Buffer).toString()).toBe(DATA.toString());
    // node → ours
    expect((z.gunzipSync(nodeZlib.gzipSync(DATA)) as Buffer).toString()).toBe(DATA.toString());
  });

  it("deflateSync/inflateSync (zlib format) round-trip", () => {
    expect(nodeZlib.inflateSync(z.deflateSync(DATA) as Buffer).toString()).toBe(DATA.toString());
    expect((z.inflateSync(nodeZlib.deflateSync(DATA)) as Buffer).toString()).toBe(DATA.toString());
  });

  it("deflateRawSync/inflateRawSync round-trip", () => {
    expect(nodeZlib.inflateRawSync(z.deflateRawSync(DATA) as Buffer).toString()).toBe(DATA.toString());
    expect((z.inflateRawSync(nodeZlib.deflateRawSync(DATA)) as Buffer).toString()).toBe(DATA.toString());
  });

  it("unzipSync detects gzip and zlib wrappers", () => {
    expect((z.unzipSync(nodeZlib.gzipSync(DATA)) as Buffer).toString()).toBe(DATA.toString());
    expect((z.unzipSync(nodeZlib.deflateSync(DATA)) as Buffer).toString()).toBe(DATA.toString());
  });

  it("respects level option", () => {
    const small = z.deflateSync(DATA, { level: 0 }) as Buffer;
    const tight = z.deflateSync(DATA, { level: 9 }) as Buffer;
    expect(small.length).toBeGreaterThan(tight.length);
    expect((z.inflateSync(tight) as Buffer).toString()).toBe(DATA.toString());
  });
});

describe("callback codecs", () => {
  it("gzip/gunzip callback signatures", async () => {
    const compressed = await new Promise<Buffer>((res, rej) =>
      z.gzip(DATA, (e, b) => (e ? rej(e) : res(b))),
    );
    const plain = await new Promise<Buffer>((res, rej) =>
      z.gunzip(compressed, (e, b) => (e ? rej(e) : res(b))),
    );
    expect(plain.toString()).toBe(DATA.toString());
  });

  it("brotliCompress/brotliDecompress callbacks", async () => {
    const compressed = await new Promise<Buffer>((res, rej) =>
      z.brotliCompress(DATA, (e, b) => (e ? rej(e) : res(b))),
    );
    const plain = await new Promise<Buffer>((res, rej) =>
      z.brotliDecompress(compressed, (e, b) => (e ? rej(e) : res(b))),
    );
    expect(plain.toString()).toBe(DATA.toString());
  });
});

describe("brotli", () => {
  it("stored-block output decodes via node:zlib", () => {
    const out = z.brotliCompressSync(DATA) as Buffer;
    expect(nodeZlib.brotliDecompressSync(out).toString()).toBe(DATA.toString());
  });

  it("decodes real brotli produced by node:zlib", () => {
    const real = nodeZlib.brotliCompressSync(DATA, {
      params: { [nodeZlib.constants.BROTLI_PARAM_QUALITY]: 8 },
    });
    expect((z.brotliDecompressSync(real) as Buffer).toString()).toBe(DATA.toString());
  });

  it("handles empty input", () => {
    const out = z.brotliCompressSync(Buffer.alloc(0)) as Buffer;
    expect(nodeZlib.brotliDecompressSync(out).length).toBe(0);
  });
});

describe("streams", () => {
  it("createGzip stream → node gunzip", async () => {
    const compressed = await collect(z.createGzip() as never, [DATA.subarray(0, 50), DATA.subarray(50)]);
    expect(nodeZlib.gunzipSync(compressed).toString()).toBe(DATA.toString());
  });

  it("createGunzip stream decodes node output in chunks", async () => {
    const compressed = nodeZlib.gzipSync(DATA);
    const plain = await collect(z.createGunzip() as never, [
      compressed.subarray(0, 7),
      compressed.subarray(7),
    ]);
    expect(plain.toString()).toBe(DATA.toString());
  });

  it("createDeflate + createInflate pipeline", async () => {
    const compressed = await collect(z.createDeflate() as never, [DATA]);
    const plain = await collect(z.createInflate() as never, [
      compressed.subarray(0, 3),
      compressed.subarray(3),
    ]);
    expect(plain.toString()).toBe(DATA.toString());
  });

  it("pipe() forwards data into a writable sink", async () => {
    const gz = z.createGzip();
    const sink = {
      chunks: [] as Buffer[],
      ended: false,
      write(c: Buffer) {
        this.chunks.push(c);
        return true;
      },
      end() {
        this.ended = true;
      },
      on() {
        return this;
      },
    };
    const done = new Promise<void>((res) => gz.on("end", () => res()));
    gz.pipe(sink as never);
    gz.end(DATA);
    await done;
    expect(sink.ended).toBe(true);
    expect(nodeZlib.gunzipSync(Buffer.concat(sink.chunks)).toString()).toBe(DATA.toString());
  });
});

describe("zstd", () => {
  // Node ≥24 does not necessarily expose "zstd" through the web
  // (De)CompressionStream globals the shim uses — feature-detect so the
  // round-trip cases stay green everywhere, the surface checks don't care.
  const zstdStreams = (() => {
    try {
      new DecompressionStream("zstd");
      return true;
    } catch {
      return false;
    }
  })();

  it("exports the surface and constants", () => {
    for (const name of [
      "ZstdCompress", "ZstdDecompress",
      "createZstdCompress", "createZstdDecompress",
      "zstdCompress", "zstdDecompress",
    ]) {
      expect(Object.keys(z), name).toContain(name);
      expect(z[name as keyof typeof z], name).toBeDefined();
    }
    // same constants undici reaches for
    expect(z.constants.ZSTD_e_continue).toBe(0);
    expect(z.constants.ZSTD_e_flush).toBe(1);
    expect(z.constants.ZSTD_e_end).toBe(2);
    expect(z.constants.ZSTD_c_compressionLevel).toBe(100);
    expect(z.constants.ZSTD_CLEVEL_DEFAULT).toBe(3);
  });

  it("sync one-shots throw a descriptive error (no sync codec)", () => {
    expect(() => z.zstdCompressSync(DATA)).toThrow(/zstd/i);
    expect(() => z.zstdDecompressSync(DATA)).toThrow(/zstd/i);
  });

  it.skipIf(!zstdStreams)("createZstdDecompress stream decodes node:zlib output", async () => {
    const compressed = nodeZlib.zstdCompressSync(DATA);
    const plain = await collect(z.createZstdDecompress() as never, [
      compressed.subarray(0, 5),
      compressed.subarray(5),
    ]);
    expect(plain.toString()).toBe(DATA.toString());
  });

  it.skipIf(!zstdStreams)("zstdDecompress callback decodes node:zlib output", async () => {
    const plain = await new Promise<Buffer>((res, rej) =>
      z.zstdDecompress(nodeZlib.zstdCompressSync(DATA), (e, b) =>
        e ? rej(e) : res(b),
      ),
    );
    expect(plain.toString()).toBe(DATA.toString());
  });

  it.skipIf(!zstdStreams)("createZstdCompress output decodes via node:zlib", async () => {
    const compressed = await collect(z.createZstdCompress() as never, [DATA]);
    expect(nodeZlib.zstdDecompressSync(compressed).toString()).toBe(DATA.toString());
  });
});

describe("crc32", () => {
  it("matches node:zlib", () => {
    expect(z.crc32("abc")).toBe(nodeZlib.crc32("abc"));
    expect(z.crc32(DATA)).toBe(nodeZlib.crc32(DATA));
    // incremental: crc32(data2, crc32(data1)) === crc32(concat)
    const a = nodeZlib.crc32("hello ");
    expect(z.crc32("world", a)).toBe(nodeZlib.crc32("hello world"));
  });
});
