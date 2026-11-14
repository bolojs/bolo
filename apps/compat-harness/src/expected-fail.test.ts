import { describe, it, expect } from "vitest";
import expectations from "./expectations.json";
import {
  expectedFailEntry,
  isPlatformBound,
  ledgerOutcome,
  validateLedger,
  LANES,
  type ExpectedFailEntry,
} from "./expected-fail.js";

const entries = expectations as unknown as Record<string, ExpectedFailEntry>;

describe("expected-fail ledger", () => {
  it("has no structural problems", () => {
    expect(validateLedger(entries)).toEqual([]);
  });

  it("only uses lanes A/B/C", () => {
    for (const entry of Object.values(entries)) {
      expect(LANES).toContain(entry.lane);
    }
  });

  it("tags every platform-bound family the plan calls out", () => {
    const laneOf = (suffix: string) =>
      Object.entries(entries).find(([file]) => file.endsWith(suffix))?.[1].lane;
    expect(laneOf("test-tls-legacy-deprecated.js")).toBe("B");
    expect(laneOf("test-tls-ticket-12.js")).toBe("B");
    expect(laneOf("test-inspector-stops-no-file.js")).toBe("C");
    expect(laneOf("test-dns-set-default-order.js")).toBe("C");
    expect(laneOf("test-timers-interval-promisified.js")).toBe("A");
  });
});

describe("expectedFailEntry", () => {
  it("returns the entry for a listed file and undefined otherwise", () => {
    const entry = expectedFailEntry("test/parallel/test-tls-ticket-12.js");
    expect(entry?.lane).toBe("B");
    expect(entry?.location).toContain("tls");
    expect(expectedFailEntry("test/parallel/test-path-join.js")).toBeUndefined();
  });
});

describe("isPlatformBound", () => {
  it("is true only for lane C", () => {
    const base = { reason: "r", location: "l", remediation: "m" };
    expect(isPlatformBound({ ...base, lane: "A" })).toBe(false);
    expect(isPlatformBound({ ...base, lane: "B" })).toBe(false);
    expect(isPlatformBound({ ...base, lane: "C" })).toBe(true);
  });
});

describe("ledgerOutcome", () => {
  const entry = (lane: ExpectedFailEntry["lane"]): ExpectedFailEntry => ({
    lane,
    reason: "r",
    location: "l",
    remediation: "m",
  });

  it("passes through unlisted results unchanged", () => {
    expect(ledgerOutcome("pass", undefined)).toBe("pass");
    expect(ledgerOutcome("fail", undefined)).toBe("fail");
    expect(ledgerOutcome("skip", undefined)).toBe("skip");
  });

  it("flags a listed file that passed as a stale expectation", () => {
    for (const lane of LANES) expect(ledgerOutcome("pass", entry(lane))).toBe("stale-pass");
  });

  it("buckets failing listed files by lane", () => {
    expect(ledgerOutcome("fail", entry("A"))).toBe("fixable-fail");
    expect(ledgerOutcome("fail", entry("B"))).toBe("fixable-fail");
    expect(ledgerOutcome("fail", entry("C"))).toBe("expected-fail");
  });

  it("never treats a skip as an expected failure", () => {
    expect(ledgerOutcome("skip", entry("C"))).toBe("skip");
  });
});
