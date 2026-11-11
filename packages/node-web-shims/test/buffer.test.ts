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
});
