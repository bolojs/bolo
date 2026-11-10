import { supportsSnapshots, type SandboxBackend } from "@bolojs/runtime";

/**
 * Differential conformance harness for SandboxBackend implementations.
 *
 * Cases declare the expected output; runConformance() executes each case on a
 * fresh backend instance and diffs. runSnapshotRoundTrip() adds the
 * snapshot→restore axis: a case runs uninterrupted on one backend as the
 * oracle, and setup→snapshot→fresh backend→restore→continuation on another;
 * divergence means the snapshot did not preserve state.
 *
 * Backends that cannot evaluate expressions under happy-dom (IframeSandbox)
 * plug into the same suite from e2e or their own package's tests.
 */

export interface ExpectedResult {
  result?: string | RegExp;
  error?: string | RegExp;
}

export interface ConformanceCase {
  name: string;
  code: string;
  expected: ExpectedResult;
}

export interface SnapshotCase {
  name: string;
  /** Establishes state to be captured. */
  setup: string;
  /** Runs after snapshot+restore; must observe setup state. */
  then: string;
  expected: ExpectedResult;
}

export interface CaseResult {
  name: string;
  pass: boolean;
  expected: ExpectedResult;
  actual: { result?: string; error?: string };
}

export const SANDBOX_CASES: ConformanceCase[] = [
  { name: "arithmetic", code: "40 + 2", expected: { result: "42" } },
  {
    name: "array-ops",
    code: "[1, 2, 3].map((x) => x * 2).join(',')",
    expected: { result: "2,4,6" },
  },
  { name: "string-method", code: "'bolo'.toUpperCase()", expected: { result: "BOLO" } },
  {
    name: "json-roundtrip",
    code: "JSON.stringify(JSON.parse('{\"a\":1}'))",
    expected: { result: '{"a":1}' },
  },
  {
    name: "thrown-error",
    code: "(() => { throw new Error('boom'); })()",
    expected: { error: /boom/ },
  },
];

export const SNAPSHOT_CASES: SnapshotCase[] = [
  {
    name: "counter-survives-restore",
    setup: "globalThis.__count = (globalThis.__count ?? 0) + 1;",
    then: "globalThis.__count",
    expected: { result: "1" },
  },
];

const matchField = (expected: string | RegExp | undefined, actual: string | undefined) => {
  if (expected === undefined) return actual === undefined;
  if (actual === undefined) return false;
  return expected instanceof RegExp ? expected.test(actual) : expected === actual;
};

export const matchesExpected = (
  expected: ExpectedResult,
  actual: { result?: string; error?: string },
): boolean =>
  matchField(expected.result, actual.result) && matchField(expected.error, actual.error);

export const runConformance = async (
  cases: ConformanceCase[],
  makeBackend: () => SandboxBackend | Promise<SandboxBackend>,
): Promise<CaseResult[]> => {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const backend = await makeBackend();
    try {
      const actual = await backend.run(c.code);
      results.push({
        name: c.name,
        pass: matchesExpected(c.expected, actual),
        expected: c.expected,
        actual,
      });
    } finally {
      backend.dispose();
    }
  }
  return results;
};

export const runSnapshotRoundTrip = async (
  c: SnapshotCase,
  makeBackend: () => SandboxBackend | Promise<SandboxBackend>,
): Promise<CaseResult> => {
  // Oracle: one uninterrupted backend runs setup then the continuation.
  const oracle = await makeBackend();
  let expected: { result?: string; error?: string };
  try {
    await oracle.run(c.setup);
    expected = await oracle.run(c.then);
  } finally {
    oracle.dispose();
  }

  // Subject: snapshot after setup, restore into a fresh backend, continue.
  const first = await makeBackend();
  let actual: { result?: string; error?: string };
  try {
    await first.run(c.setup);
    if (!supportsSnapshots(first)) {
      throw new Error(`Backend under test does not implement snapshot/restore (case: ${c.name})`);
    }
    const snap = await first.snapshot();
    const second = await makeBackend();
    try {
      await second.restore(snap);
      actual = await second.run(c.then);
    } finally {
      second.dispose();
    }
  } finally {
    first.dispose();
  }

  // The restored run must match the uninterrupted oracle, not just the
  // declared expectation.
  return {
    name: c.name,
    pass: matchField(expected.result, actual.result) && matchField(expected.error, actual.error),
    expected: { result: expected.result, error: expected.error },
    actual,
  };
};
