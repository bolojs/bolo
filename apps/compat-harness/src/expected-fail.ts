import expectations from "./expectations.json";

/**
 * Expected-fail lanes (see .agents/plans compat roadmap):
 * - A: fixable shim bug — still counts as a failure so the score keeps
 *   reflecting fixable gaps.
 * - B: defined seam work (backend/minimal default not yet wired) — also
 *   still counts as a failure.
 * - C: no browser-faithful mapping — a true expected-fail, excluded from the
 *   fixable-failure count in the compat report.
 */
export type FailLane = "A" | "B" | "C";

export interface ExpectedFailEntry {
  readonly lane: FailLane;
  readonly reason: string;
  readonly location: string;
  readonly remediation: string;
}

const ledger = expectations as unknown as Record<string, ExpectedFailEntry>;

export const LANES: readonly FailLane[] = ["A", "B", "C"];

export const expectedFailEntry = (file: string): ExpectedFailEntry | undefined => ledger[file];

/** Lane C is the only lane excluded from the fixable-failure score. */
export const isPlatformBound = (entry: ExpectedFailEntry): boolean => entry.lane === "C";

/**
 * Buckets a finished test result against the ledger. `stale` means the entry
 * expected a failure but the test passed — the expectation is stale and must
 * be removed (an alarm, never silent).
 */
export type LedgerOutcome =
  | "expected-fail"
  | "fixable-fail"
  | "stale-pass"
  | "pass"
  | "fail"
  | "skip";

export const ledgerOutcome = (
  status: "pass" | "fail" | "skip",
  entry: ExpectedFailEntry | undefined,
): LedgerOutcome => {
  if (!entry) return status;
  if (status === "pass") return "stale-pass";
  if (status === "skip") return "skip";
  return entry.lane === "C" ? "expected-fail" : "fixable-fail";
};

/** Validates ledger shape; used by tests and safe to call at module load. */
export const validateLedger = (entries: Record<string, ExpectedFailEntry>): string[] => {
  const problems: string[] = [];
  for (const [file, entry] of Object.entries(entries)) {
    if (!LANES.includes(entry?.lane)) problems.push(`${file}: invalid lane ${entry?.lane}`);
    for (const field of ["reason", "location", "remediation"] as const) {
      if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
        problems.push(`${file}: missing ${field}`);
      }
    }
  }
  return problems;
};
