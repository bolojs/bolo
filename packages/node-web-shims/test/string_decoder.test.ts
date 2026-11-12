import { describe, it, expect } from "vitest";
import { createStringDecoderShim, StringDecoder } from "../src/string_decoder.ts";
import { Buffer } from "node:buffer";

describe("node-web-shims: string_decoder", () => {
  it("exposes StringDecoder as an enumerable key", () => {
    const shim = createStringDecoderShim();
    expect(Object.keys(shim)).toContain("StringDecoder");
    expect(shim.StringDecoder).toBe(StringDecoder);
  });

  it("decodes a complete utf8 buffer", () => {
    const d = new StringDecoder("utf8");
    expect(d.write(Buffer.from("hello"))).toBe("hello");
  });

  it("buffers a partial multi-byte utf8 character across writes", () => {
    const d = new StringDecoder("utf8");
    const euro = Buffer.from([0xe2, 0x82, 0xac]); // €
    expect(d.write(euro.subarray(0, 2))).toBe("");
    expect(d.write(euro.subarray(2))).toBe("€");
  });

  it("end() flushes a dangling partial character as U+FFFD", () => {
    const d = new StringDecoder("utf8");
    d.write(Buffer.from([0xe2, 0x82]));
    expect(d.end()).toBe("�");
  });

  it("decodes utf16le including surrogate pairs split across writes", () => {
    const d = new StringDecoder("utf16le");
    const buf = Buffer.from("😀", "utf16le");
    expect(d.write(buf.subarray(0, 2))).toBe("");
    expect(d.write(buf.subarray(2))).toBe("😀");
  });

  it("handles base64 across writes", () => {
    // StringDecoder('base64') *encodes* bytes into base64, splitting output
    // on 3-byte boundaries so partial writes stay valid base64.
    const d = new StringDecoder("base64");
    expect(d.write(Buffer.from("he"))).toBe("");
    expect(d.write(Buffer.from("llo"))).toBe("aGVs");
    expect(d.end()).toBe("bG8=");
  });

  it("passes strings through write() unchanged", () => {
    const d = new StringDecoder();
    expect(d.write("abc")).toBe("abc");
  });

  it("rejects non-buffer input with ERR_INVALID_ARG_TYPE", () => {
    const d = new StringDecoder();
    expect(() => d.write({} as unknown as Buffer)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it("rejects unknown encodings with ERR_UNKNOWN_ENCODING", () => {
    expect(() => new StringDecoder("bogus")).toThrowError(
      expect.objectContaining({ code: "ERR_UNKNOWN_ENCODING" }),
    );
  });
});

describe("node-web-shims: string_decoder fuzz (Node's test-string-decoder-fuzz)", () => {
  it("chunked decoding equals one-shot Buffer.toString for every encoding", () => {
    const encodings = ["utf16le", "utf8", "ascii", "hex", "base64", "latin1", "base64url"] as const;
    let seed = 42;
    const rand = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * max);
    };
    for (let round = 0; round < 200; round++) {
      const enc = encodings[rand(encodings.length)] as (typeof encodings)[number];
      const decoder = new StringDecoder(enc);
      const bufs: Buffer[] = [];
      const strings: string[] = [];
      const n = rand(10);
      for (let i = 0; i < n; i++) {
        const buf = Buffer.allocUnsafe(rand(50));
        for (let i = 0; i < buf.length; i++) buf[i] = rand(256);
        bufs.push(buf);
        strings.push(decoder.write(buf));
      }
      strings.push(decoder.end());
      expect(strings.join(""), `encoding ${enc}`).toBe(
        Buffer.concat(bufs).toString(enc as BufferEncoding),
      );
    }
  });

  it("end() reuses the decoder like Node", () => {
    const d = new StringDecoder();
    expect(d.write(Buffer.from([0xe2, 0x82]))).toBe("");
    expect(d.end()).toBe("\uFFFD");
    expect(d.write(Buffer.from("ok"))).toBe("ok");
    expect(d.end()).toBe("");
  });
});
