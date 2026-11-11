import { describe, it, expect } from "vitest";
import { createV8Shim } from "../src/v8.js";
import { createHttp2Shim } from "../src/http2.js";

describe("v8 shim", () => {
  it("getHeapStatistics/getHeapSpaceStatistics/getHeapCodeStatistics return Node-shaped data", () => {
    const v8 = createV8Shim();
    const heap = v8.getHeapStatistics();
    expect(heap).toHaveProperty("total_heap_size");
    expect(heap).toHaveProperty("used_heap_size");
    const spaces = v8.getHeapSpaceStatistics();
    expect(Array.isArray(spaces)).toBe(true);
    expect(spaces[0]).toHaveProperty("space_name");
    expect(v8.getHeapCodeStatistics()).toHaveProperty("code_and_metadata_size");
  });

  it("serialize/deserialize round-trips a structuredClone-capable value", () => {
    const v8 = createV8Shim();
    const buf = v8.serialize({ a: [1, 2], nested: { b: "x" } });
    expect(v8.deserialize(buf)).toEqual({ a: [1, 2], nested: { b: "x" } });
  });

  it("deserialize on a foreign buffer throws a Node-coded error", () => {
    const v8 = createV8Shim();
    expect(() => v8.deserialize(new Uint8Array([1, 2, 3]))).toThrowError(
      expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }),
    );
  });

  it("setFlagsFromString is a no-op", () => {
    const v8 = createV8Shim();
    expect(() => v8.setFlagsFromString("--expose-gc")).not.toThrow();
  });
});

describe("http2 shim", () => {
  it("exposes constants and settings helpers for import-time use", () => {
    const http2 = createHttp2Shim();
    expect(http2.constants.HTTP2_HEADER_STATUS).toBe(":status");
    expect(http2.getDefaultSettings()).toHaveProperty("headerTableSize");
    expect(http2.getPackedSettings()).toBeInstanceOf(Uint8Array);
    expect(typeof http2.getUnpackedSettings).toBe("function");
    expect(http2.Http2ServerRequest).toBeDefined();
    expect(http2.Http2ServerResponse).toBeDefined();
    expect(http2.sensitiveHeaders).toBeDefined();
  });

  it("session entry points throw Node-coded platform errors", () => {
    const http2 = createHttp2Shim();
    for (const fn of [http2.connect, http2.createServer, http2.createSecureServer]) {
      expect(() => fn()).toThrowError(
        expect.objectContaining({ code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" }),
      );
    }
  });
});
