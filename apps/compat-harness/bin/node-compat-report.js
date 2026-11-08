// Pure transform from the node-test runner's detailed results to the
// node-compat.json shape consumed by the site
// (apps/site/landing/public/results/node-compat.json -> apps/site/compat's
// sync-data script). Plain ESM so both bin/cli.js (node) and tests/unit
// (vitest) can import it without a build step.

const MAX_ERROR_LENGTH = 300;

const firstLine = (text) => {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}...` : line;
};

const summarizeError = (result) => {
  if (result.status === "skip") return "skipped";
  return firstLine(result.output) ?? `exit code ${result.exitCode}`;
};

const basename = (file) => file.split("/").pop() ?? file;

/**
 * @param {Array<{module: string, results: Array<{file: string, status: string, exitCode: number, output: string}>}>} modules
 * @param {{nodeVersion: string, generatedAt?: string}} options
 */
export const toNodeCompatReport = (modules, { nodeVersion, generatedAt } = {}) => {
  const tests = modules.flatMap((m) => m.results);
  const count = (status) => tests.filter((t) => t.status === status).length;
  return {
    nodeVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
    // The CLI only reaches this point when every canary failed as expected,
    // so a report it writes is by definition a validated measurement.
    validated: true,
    total: tests.length,
    pass: count("pass"),
    fail: count("fail"),
    skip: count("skip"),
    modules: modules.map((m) => ({
      name: m.module,
      passed: m.results.filter((r) => r.status === "pass").length,
      total: m.results.length,
      tests: m.results.map((r) => {
        const test = { file: basename(r.file), status: r.status };
        if (r.status !== "pass") test.error = summarizeError(r);
        return test;
      }),
    })),
  };
};
