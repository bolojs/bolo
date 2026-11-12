import { describe, it, expect } from "vitest";
import { createBufferShim } from "../src/buffer.ts";

describe("node-web-shims: buffer", () => {
  it("should match node:buffer type shape", () => {
    const shim = createBufferShim();
    const _nodeBuffer: typeof import("node:buffer") = shim;
    expect(_nodeBuffer).toBeDefined();
  });

  it("should export Buffer", () => {
    const shim = createBufferShim();
    expect(shim.Buffer).toBeDefined();
  });

  it("should export Blob", () => {
    const shim = createBufferShim();
    expect(shim.Blob).toBeDefined();
  });

  it("supports base64url encoding in toString, from, isEncoding, and byteLength", () => {
    const shim = createBufferShim();
    const { Buffer } = shim;
    expect(Buffer.isEncoding("base64url")).toBe(true);
    expect(Buffer.isEncoding("BASE64URL")).toBe(true);

    const buf = Buffer.from("hello world?+/>");
    const b64url = buf.toString("base64url");
    expect(b64url).not.toContain("+");
    expect(b64url).not.toContain("/");
    expect(b64url).not.toContain("=");

    const decoded = Buffer.from(b64url, "base64url");
    expect(decoded.toString("utf8")).toBe("hello world?+/>");

    expect(Buffer.byteLength(b64url, "base64url")).toBe(buf.length);

    const target = Buffer.alloc(30);
    const written = target.write(b64url, "base64url");
    expect(written).toBe(buf.length);
    expect(target.subarray(0, written).toString("utf8")).toBe("hello world?+/>");
  });

  it("Buffer.concat validates the list and its items like Node", () => {
    const { Buffer } = createBufferShim();
    expect(() => (Buffer as unknown as { concat: (v: unknown) => void }).concat(undefined)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => (Buffer as unknown as { concat: (v: unknown) => void }).concat(null)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() =>
      (Buffer as unknown as { concat: (v: unknown) => void }).concat([
        Buffer.from("hello"),
        3,
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: expect.stringContaining('The "list[1]" argument'),
      }),
    );
    // A valid list still concatenates.
    expect(
      (
        Buffer as unknown as { concat: (v: unknown[]) => { toString(): string } }
      ).concat([Buffer.from("as"), Buffer.from("df")]).toString(),
    ).toBe("asdf");
  });

  it("Buffer.from rejects unsupported first arguments with ERR_INVALID_ARG_TYPE", () => {
    const { Buffer } = createBufferShim();
    for (const bad of [{}, null, undefined, 5n, Symbol()]) {
      expect(() =>
        (Buffer as unknown as { from: (v: unknown) => void }).from(bad),
      ).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    }
    expect(() =>
      (Buffer as unknown as { from: (v: unknown, e: string) => void }).from("", "buffer"),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_UNKNOWN_ENCODING",
        message: "Unknown encoding: buffer",
      }),
    );
  });

  it("Buffer.alloc refuses sizes above Node's maximum with ERR_OUT_OF_RANGE", () => {
    const { Buffer } = createBufferShim();
    expect(() =>
      (Buffer as unknown as { alloc: (n: number) => void }).alloc(0x80000000),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message: "Attempt to allocate Buffer larger than maximum size: 0x7fffffff bytes",
      }),
    );
  });
});
