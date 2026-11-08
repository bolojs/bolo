import { describe, it, expect } from "vitest";
import {
  classifyNodeTest,
  classifyPackageProbe,
  canaryFailedAsExpected,
  leakedCanaryNames,
} from "./classify.js";
import { assertCanariesFail } from "./canaries.js";

describe("compat-harness classify (mutation-testable pure functions)", () => {
  describe("classifyNodeTest", () => {
    it("exit 0 without skip plan is pass", () => {
      expect(classifyNodeTest(0, "ok\n1..1\n")).toBe("pass");
      expect(classifyNodeTest(0, "")).toBe("pass");
    });
    it("exit 0 with TAP skip plan is skip", () => {
      expect(classifyNodeTest(0, "some output\n1..0 # SKIP flaky on windows\n")).toBe("skip");
    });
    it("non-zero exit is fail even with skip-looking output", () => {
      expect(classifyNodeTest(1, "1..0 # SKIP")).toBe("fail");
      expect(classifyNodeTest(2, "")).toBe("fail");
      expect(classifyNodeTest(-1, "TIMEOUT")).toBe("fail");
    });
    it("skip plan must be at line start", () => {
      expect(classifyNodeTest(0, "x 1..0 # SKIP")).toBe("pass");
      expect(classifyNodeTest(0, "1..1 # SKIP")).toBe("pass");
    });
  });

  describe("classifyPackageProbe", () => {
    it("exit 0 is always pass", () => {
      expect(classifyPackageProbe(0, "")).toBe("pass");
      expect(classifyPackageProbe(0, "SKIP this is ignored")).toBe("pass");
    });
    it("non-zero exit with SKIP marker is skip", () => {
      expect(classifyPackageProbe(1, "not supported: SKIP")).toBe("skip");
      expect(classifyPackageProbe(1, "# skip arm64")).toBe("skip");
    });
    it("non-zero exit without marker is fail", () => {
      expect(classifyPackageProbe(1, "probe failed")).toBe("fail");
      expect(classifyPackageProbe(1, "")).toBe("fail");
      expect(classifyPackageProbe(2, "skip lowercase only is not a marker")).toBe("fail");
    });
  });

  describe("canaryFailedAsExpected", () => {
    it("non-zero exit counts as expected failure", () => {
      expect(canaryFailedAsExpected(1)).toBe(true);
      expect(canaryFailedAsExpected(2)).toBe(true);
      expect(canaryFailedAsExpected(-1)).toBe(true);
    });
    it("exit 0 or TIMEOUT does not count", () => {
      expect(canaryFailedAsExpected(0)).toBe(false);
      expect(canaryFailedAsExpected("TIMEOUT")).toBe(false);
    });
  });

  describe("leakedCanaryNames", () => {
    it("returns names of canaries that did not fail as expected", () => {
      expect(
        leakedCanaryNames([
          { name: "a", failedAsExpected: true },
          { name: "b", failedAsExpected: false },
          { name: "c", failedAsExpected: false },
        ]),
      ).toEqual(["b", "c"]);
    });
    it("empty input and all-passed input give empty list", () => {
      expect(leakedCanaryNames([])).toEqual([]);
      expect(leakedCanaryNames([{ name: "a", failedAsExpected: true }])).toEqual([]);
    });
  });

  describe("assertCanariesFail", () => {
    it("accepts canaries that exit non-zero", () => {
      expect(() =>
        assertCanariesFail([
          { name: "expected-error", exitCode: 1, output: "", failedAsExpected: true },
        ]),
      ).not.toThrow();
    });
    it("rejects canaries that pass or time out", () => {
      expect(() =>
        assertCanariesFail([
          { name: "passed", exitCode: 0, output: "", failedAsExpected: false },
          { name: "hung", exitCode: "TIMEOUT", output: "", failedAsExpected: false },
        ]),
      ).toThrow("INVALID RUN: canaries scored as pass/hang: passed, hung");
    });
  });
});
