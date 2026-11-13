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

  it("decodes utf8 toString with WHATWG semantics like V8", () => {
    const { Buffer } = createBufferShim();
    // A truncated 3-byte sequence is one maximal subpart → a single U+FFFD
    // (feross's hand-rolled decoder emitted one per byte).
    expect(Buffer.from([0xe2, 0x82]).toString("utf8")).toBe("�");
    // A leading BOM is data to Buffer.toString — not stripped.
    expect(Buffer.from([0xef, 0xbb, 0xbf, 0x61]).toString()).toBe("﻿a");
    // Invalid start bytes each produce one U+FFFD.
    expect(Buffer.from([0x61, 0xff, 0x62]).toString("utf8")).toBe("a�b");
  });

  it("Buffer.concat validates the list and its items like Node", () => {
    const { Buffer } = createBufferShim();
    expect(() =>
      (Buffer as unknown as { concat: (v: unknown) => void }).concat(undefined),
    ).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
    expect(() => (Buffer as unknown as { concat: (v: unknown) => void }).concat(null)).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() =>
      (Buffer as unknown as { concat: (v: unknown) => void }).concat([Buffer.from("hello"), 3]),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: expect.stringContaining('The "list[1]" argument'),
      }),
    );
    // A valid list still concatenates.
    expect(
      (Buffer as unknown as { concat: (v: unknown[]) => { toString(): string } })
        .concat([Buffer.from("as"), Buffer.from("df")])
        .toString(),
    ).toBe("asdf");
  });

  it("Buffer.from rejects unsupported first arguments with ERR_INVALID_ARG_TYPE", () => {
    const { Buffer } = createBufferShim();
    for (const bad of [{}, null, undefined, 5n, Symbol()]) {
      expect(() => (Buffer as unknown as { from: (v: unknown) => void }).from(bad)).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
      );
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

  it("Buffer.alloc surfaces V8's RangeError past the typed-array limit", () => {
    const { Buffer } = createBufferShim();
    // Node lets `new Uint8Array(size)` throw natively — a plain RangeError
    // with V8's wording and no `code` property (test-buffer-alloc).
    expect(() =>
      (Buffer as unknown as { alloc: (n: number) => void }).alloc(0x80000000),
    ).toThrowError(
      expect.objectContaining({
        message: "Invalid typed array length: 2147483648",
      }),
    );
  });

  // --- Verbatim assertions from node v22.0.0 test-buffer-concat.js --------

  it("Buffer.concat rejects a non-Array list with Node's exact message", () => {
    const { Buffer } = createBufferShim();
    const concat = (v: unknown) => () =>
      (Buffer as unknown as { concat: (v: unknown) => void }).concat(v);
    const cases: Array<[unknown, string]> = [
      [undefined, 'The "list" argument must be an instance of Array. Received undefined'],
      [null, 'The "list" argument must be an instance of Array. Received null'],
      [
        Buffer.from("hello"),
        'The "list" argument must be an instance of Array. Received an instance of Buffer',
      ],
    ];
    for (const [value, message] of cases) {
      expect(concat(value)).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", message }),
      );
    }
  });

  it("Buffer.concat rejects non-Buffer items with Node's exact message", () => {
    const { Buffer } = createBufferShim();
    const concat = (v: unknown) => () =>
      (Buffer as unknown as { concat: (v: unknown) => void }).concat(v);
    const prefix = 'The "list[0]" argument must be an instance of Buffer or Uint8Array.';
    for (const [value, suffix] of [
      [42, " Received type number (42)"],
      ["hello", " Received type string ('hello')"],
    ] as Array<[unknown, string]>) {
      expect(concat([value])).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", message: prefix + suffix }),
      );
      expect(concat([value, Buffer.from("world")])).toThrowError(
        expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE", message: prefix + suffix }),
      );
    }
    expect(concat([Buffer.from("hello"), 3])).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message:
          'The "list[1]" argument must be an instance of Buffer or Uint8Array. ' +
          "Received type number (3)",
      }),
    );
  });

  it("Buffer.concat concatenates and zero-fills like Node", () => {
    const { Buffer } = createBufferShim();
    const empty = Buffer.alloc(0);
    const random10 = Buffer.alloc(10, 1);
    expect(Buffer.concat([], 100)).toEqual(empty);
    expect(Buffer.concat([random10], 0)).toEqual(empty);
    expect(Buffer.concat([random10], 10)).toEqual(random10);
    expect(Buffer.concat([random10, random10], 10)).toEqual(random10);
    expect(Buffer.concat([empty, random10])).toEqual(random10);
    expect(Buffer.concat([random10, empty, empty])).toEqual(random10);
    // The tail should be zero-filled.
    expect(Buffer.concat([empty], 100)).toEqual(Buffer.alloc(100));
    expect(Buffer.concat([empty], 4096)).toEqual(Buffer.alloc(4096));
    expect(Buffer.concat([random10], 40)).toEqual(Buffer.concat([random10, Buffer.alloc(30)]));
    expect(Buffer.concat([new Uint8Array([0x41, 0x42]), new Uint8Array([0x43, 0x44])])).toEqual(
      Buffer.from("ABCD"),
    );
    // A single-item list must still return a new buffer.
    const one = [Buffer.from("asdf")];
    const flatOne = Buffer.concat(one);
    expect(flatOne).not.toBe(one[0]);
    expect(flatOne.toString()).toBe("asdf");
  });

  // --- Verbatim assertions from node v22.0.0 test-buffer-from.js --------

  it("Buffer.from rejects invalid input with Node's exact message", () => {
    const { Buffer } = createBufferShim();
    const prefix =
      "The first argument must be of type string or an instance of " +
      "Buffer, ArrayBuffer, or Array or an Array-like Object.";
    const cases: Array<[unknown, string]> = [
      [{}, " Received an instance of Object"],
      [new Boolean(true), " Received an instance of Boolean"],
      [{ valueOf: null }, " Received an instance of Object"],
      [new Number(true), " Received an instance of Number"],
      [5n, " Received type bigint (5n)"],
      [function foo() {}, " Received function foo"],
      [undefined, " Received undefined"],
      [null, " Received null"],
      [Symbol(), " Received type symbol (Symbol())"],
    ];
    for (const [input, suffix] of cases) {
      const from = () => (Buffer as unknown as { from: (v: unknown) => void }).from(input);
      const fromHex = () =>
        (Buffer as unknown as { from: (v: unknown, e: string) => void }).from(input, "hex");
      const expected = expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        name: "TypeError",
        message: prefix + suffix,
      });
      expect(from).toThrowError(expected);
      expect(fromHex).toThrowError(expected);
    }
  });

  it("Buffer.from honors Symbol.toPrimitive like Node", () => {
    const { Buffer } = createBufferShim();
    const myPrimitive = {
      [Symbol.toPrimitive]: () => "test",
    };
    expect(Buffer.from(myPrimitive)).toEqual(Buffer.from("test"));
    const myBadPrimitive = {
      [Symbol.toPrimitive]: () => 1,
    };
    expect(() => Buffer.from(myBadPrimitive)).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message:
          "The first argument must be of type string or an instance of " +
          "Buffer, ArrayBuffer, or Array or an Array-like Object. " +
          "Received an instance of Object",
      }),
    );
  });

  // --- Verbatim assertions from node v22.0.0 test-buffer-alloc.js --------

  it("Buffer.alloc validates size and fill like Node", () => {
    const { Buffer } = createBufferShim();
    const alloc = (n: unknown, fill?: unknown, encoding?: unknown) => () =>
      (Buffer as unknown as { alloc: (n: unknown, f?: unknown, e?: unknown) => void }).alloc(
        n,
        fill,
        encoding,
      );
    expect(alloc(-1)).toThrowError(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        name: "RangeError",
        message:
          'The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. ' +
          "Received -1",
      }),
    );
    expect(alloc(Number.NaN)).toThrowError(
      expect.objectContaining({
        code: "ERR_OUT_OF_RANGE",
        message:
          'The value of "size" is out of range. It must be >= 0 && <= 9007199254740991. ' +
          "Received NaN",
      }),
    );
    expect(alloc("x")).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        name: "TypeError",
        message: "The \"size\" argument must be of type number. Received type string ('x')",
      }),
    );
    expect(alloc(1, Buffer.alloc(0))).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
        name: "TypeError",
        message: "The argument 'value' is invalid. Received <Buffer >",
      }),
    );
    expect(alloc(40, "x", 20)).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        name: "TypeError",
        message: 'The "encoding" argument must be of type string. Received type number (20)',
      }),
    );
    // Valid fills still work.
    expect(Buffer.alloc(4, "a")).toEqual(Buffer.from("aaaa"));
    expect(Buffer.alloc(4, "6161", "hex")).toEqual(Buffer.from("aaaa"));
  });

  it("Buffer#copy rejects a missing target with Node's exact message", () => {
    const { Buffer } = createBufferShim();
    expect(() =>
      (Buffer.allocUnsafe(10) as unknown as { copy: (t?: unknown) => void }).copy(),
    ).toThrowError(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        name: "TypeError",
        message:
          'The "target" argument must be an instance of Buffer or Uint8Array. Received undefined',
      }),
    );
  });
});
