/**
 * Pure scoring/classification logic for the compat harness, extracted so it
 * is unit-testable and mutation-testable (see apps/compat-harness/stryker.conf.json).
 */

export type RunStatus = "pass" | "fail" | "skip";

/**
 * Node's test/common `skip()` prints a TAP skip plan and exits 0, so exit 0
 * alone is not enough to distinguish pass from skip.
 */
export const classifyNodeTest = (exitCode: number, output: string): RunStatus => {
  if (exitCode === 0 && /^1\.\.0 # SKIP/m.test(output)) return "skip";
  return exitCode === 0 ? "pass" : "fail";
};

const PASS_MARKER = /^PASS[ \t\r]*$/m;
const SKIP_MARKER = /\bskip\b/i;
/**
 * A pass requires both a clean exit and the explicit PASS marker: exit 0 alone
 * proved nothing under the old esm.sh matrix (falsy probes, swallowed throws).
 * A skip marker classifies a skipped probe regardless of exit code.
 */
export const classifyPackageProbe = (exitCode: number, output: string): RunStatus => {
  if (exitCode === 0 && PASS_MARKER.test(output)) return "pass";
  if (SKIP_MARKER.test(output)) return "skip";
  return "fail";
};

/** A hang is not a pass either, but only a real non-zero exit counts as correct. */
export const canaryFailedAsExpected = (exitCode: number | "TIMEOUT"): boolean =>
  typeof exitCode === "number" && exitCode !== 0;

export interface CanaryVerdict {
  name: string;
  failedAsExpected: boolean;
}

export const leakedCanaryNames = (results: readonly CanaryVerdict[]): string[] =>
  results.filter((r) => !r.failedAsExpected).map((r) => r.name);
