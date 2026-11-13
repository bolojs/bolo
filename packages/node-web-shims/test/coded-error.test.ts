import { describe, it, expect } from "vitest";
import { unsupportedError, withCode } from "../src/coded-error.ts";

describe("unsupportedError", () => {
  it("produces an ERR_BOL_UNSUPPORTED_<SEAM> coded error naming the seam", () => {
    const err = unsupportedError(
      "TLS_BACKEND",
      "tls.connect() requires a TLS backend",
    ) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ERR_BOL_UNSUPPORTED_TLS_BACKEND");
    expect(err.message).toBe("tls.connect() requires a TLS backend");
    expect(String(err)).toBe(
      "Error [ERR_BOL_UNSUPPORTED_TLS_BACKEND]: tls.connect() requires a TLS backend",
    );
    expect(err.name).toBe("Error");
  });

  it("keeps the code non-enumerable like Node's internal errors", () => {
    const err = unsupportedError("DGRAM_BACKEND", "no udp") as Error & { code?: string };
    expect(Object.keys(err)).not.toContain("code");
    expect(err.code).toBe("ERR_BOL_UNSUPPORTED_DGRAM_BACKEND");
  });
});

describe("withCode", () => {
  it("still works standalone", () => {
    const err = withCode(new TypeError("bad"), "ERR_X") as TypeError & { code?: string };
    expect(err.name).toBe("TypeError");
    expect(err.code).toBe("ERR_X");
    expect(String(err)).toBe("TypeError [ERR_X]: bad");
  });
});
