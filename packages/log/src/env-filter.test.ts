import { describe, expect, it } from "vitest";
import { createConsoleFilter, parseBoloLogEnv } from "./env-filter.js";
import type { LogRecord } from "@logtape/logtape";

function record(category: string[], level: LogRecord["level"]): LogRecord {
  return {
    category,
    level,
    message: [""],
    rawMessage: "",
    timestamp: 0,
    properties: {},
  };
}

describe("parseBoloLogEnv", () => {
  it("parses category=level pairs", () => {
    const overrides = parseBoloLogEnv("sandbox=debug,net-shim=trace");
    expect(overrides.get("sandbox")).toBe("debug");
    expect(overrides.get("net-shim")).toBe("trace");
  });

  it("ignores invalid levels and empty segments", () => {
    const overrides = parseBoloLogEnv("sandbox=nonsense,,=info,net-shim=");
    expect(overrides.size).toBe(0);
  });

  it("returns an empty map for undefined input", () => {
    expect(parseBoloLogEnv(undefined).size).toBe(0);
  });
});

describe("createConsoleFilter", () => {
  it("uses the default level when no override matches", () => {
    const filter = createConsoleFilter("warning", new Map());
    expect(filter(record(["bolo", "runtime", "iframe-sandbox"], "info"))).toBe(false);
    expect(filter(record(["bolo", "runtime", "iframe-sandbox"], "warning"))).toBe(true);
  });

  it("lets a matching category override lower the bar", () => {
    const overrides = new Map([["iframe-sandbox", "debug" as const]]);
    const filter = createConsoleFilter("warning", overrides);
    expect(filter(record(["bolo", "runtime", "iframe-sandbox"], "debug"))).toBe(true);
    expect(filter(record(["bolo", "other"], "debug"))).toBe(false);
  });
});
