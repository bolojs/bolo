// Pure transform from the node-test runner's detailed results to the
// node-compat.json shape consumed by the site
// (apps/site/landing/public/results/node-compat.json -> apps/site/compat's
// sync-data script). Plain ESM so both bin/cli.js (node) and tests/unit
// (vitest) can import it without a build step.

const MAX_ERROR_LENGTH = 300;

// Uncaught crashes inside the container's data: module URLs print the whole
// URL-encoded bundle as a stack-frame location line — skip those so the real
// error line surfaces instead.
const firstLine = (text) => {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("data:"));
  if (!line) return undefined;
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}...` : line;
};

const summarizeError = (result) => {
  if (result.status === "skip") return "skipped";
  return firstLine(result.output) ?? `exit code ${result.exitCode}`;
};

const basename = (file) => file.split("/").pop() ?? file;

// The runner attaches the src/expectations.json ledger entry (any lane) to
// listed files, plus `unexpectedPass` when a listed file passes (stale
// expectation — an alarm, not a pass). Lane C entries are platform-bound:
// no browser-faithful mapping exists, so they are reported as expected-fail
// and excluded from `fail`. Lane A (shim bug) and lane B (unbuilt seam work)
// still count as failures so the score reflects fixable gaps.
const ledgerEntry = (result) =>
  result.expectedFail && typeof result.expectedFail === "object"
    ? result.expectedFail
    : undefined;

const isPlatformBoundFail = (result) =>
  result.status === "fail" && ledgerEntry(result)?.lane === "C";

const tallyLane = (tally, result) => {
  const lane = ledgerEntry(result)?.lane;
  if (result.status === "fail" && (lane === "A" || lane === "B" || lane === "C")) {
    tally[lane] += 1;
  }
};

const emptyLaneTally = () => ({ A: 0, B: 0, C: 0 });

/**
 * @param {Array<{module: string, results: Array<{file: string, status: string, exitCode: number, output: string, expectedFail?: {lane: string, reason: string, location: string, remediation: string}, unexpectedPass?: boolean}>}>} modules
 * @param {{nodeVersion: string, generatedAt?: string}} options
 */
export const toNodeCompatReport = (modules, { nodeVersion, generatedAt } = {}) => {
  const tests = modules.flatMap((m) => m.results);
  const count = (status) => tests.filter((t) => t.status === status).length;
  const expectedFailByLane = emptyLaneTally();
  for (const t of tests) tallyLane(expectedFailByLane, t);
  const expectedFail = tests.filter(isPlatformBoundFail).length;
  const staleExpected = tests.filter((t) => t.unexpectedPass === true).length;
  return {
    nodeVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
    // The CLI only reaches this point when every canary failed as expected,
    // so a report it writes is by definition a validated measurement.
    validated: true,
    total: tests.length,
    pass: count("pass"),
    // Lane-C expected failures are platform-bound, not fixable gaps: they are
    // counted separately instead of inflating `fail`.
    fail: count("fail") - expectedFail,
    skip: count("skip"),
    expectedFail,
    expectedFailByLane,
    staleExpected,
    modules: modules.map((m) => {
      const moduleExpectedFail = m.results.filter(isPlatformBoundFail).length;
      const moduleLaneTally = emptyLaneTally();
      for (const r of m.results) tallyLane(moduleLaneTally, r);
      return {
        name: m.module,
        passed: m.results.filter((r) => r.status === "pass").length,
        total: m.results.length,
        expectedFail: moduleExpectedFail,
        expectedFailByLane: moduleLaneTally,
        tests: m.results.map((r) => {
          const test = { file: basename(r.file), status: r.status };
          const entry = ledgerEntry(r);
          if (entry) {
            test.expectedFail = {
              lane: entry.lane,
              reason: entry.reason,
              location: entry.location,
              remediation: entry.remediation,
            };
          }
          if (r.unexpectedPass === true) test.unexpectedPass = true;
          if (r.status !== "pass") test.error = summarizeError(r);
          return test;
        }),
      };
    }),
  };
};
