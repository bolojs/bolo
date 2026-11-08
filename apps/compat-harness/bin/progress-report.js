// Pure progress/resume bookkeeping for the compat-harness CLI, extracted so
// tests/unit can exercise it without Playwright (same pattern as
// bin/node-compat-report.js). Plain ESM, importable by both node (bin/cli.js)
// and vitest.
import { appendFile, readFile } from "node:fs/promises";

/**
 * One JSONL record per finished package. `durationMs` is rounded to whole
 * milliseconds so the file stays small and diffable.
 */
export const formatProgressLine = (result) => {
  const record = {
    name: result.name,
    status: result.status,
    durationMs: Math.round(result.duration ?? 0),
  };
  if (result.error !== undefined) record.error = result.error;
  return JSON.stringify(record);
};

/**
 * Parses a JSONL file of progress records into results. Blank and malformed
 * lines are skipped, so a run killed mid-write loses at most the torn line.
 */
export const parsePartialResults = (text) => {
  const results = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.name !== "string" || typeof record?.status !== "string") continue;
    results.push({
      name: record.name,
      class: typeof record.class === "string" ? record.class : "unknown",
      status: record.status,
      ...(record.error !== undefined ? { error: record.error } : {}),
      duration: typeof record.durationMs === "number" ? record.durationMs : undefined,
    });
  }
  return results;
};

/** Reads a partial file; a missing file means "nothing done yet". */
export const readPartialFile = async (path) => {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return parsePartialResults(text);
};

export const appendPartial = async (path, result) => {
  await appendFile(path, `${formatProgressLine(result)}\n`);
};

/**
 * Names of packages already completed in an earlier (killed) run. Timeouts are
 * failures, not completions: by default they are retried, because a timeout
 * usually means the page hung rather than the package being incompatible.
 */
export const completedNames = (results, { retryTimeouts = true } = {}) => {
  const done = new Set();
  for (const r of results) {
    if (retryTimeouts && r.status === "fail" && /TIMEOUT/.test(r.error ?? "")) continue;
    done.add(r.name);
  }
  return done;
};

/** Filters a matrix's package list down to the ones not yet completed. */
export const pendingPackages = (packages, done) => packages.filter((p) => !done.has(p.name));

/**
 * The partial file path for a given output path: `x.json` -> `x.json.partial.jsonl`.
 * The `.partial.jsonl` suffix keeps it obviously distinct from the final
 * artifact and from any sibling JSON the site consumes.
 */
export const partialPathFor = (outputPath) => `${outputPath}.partial.jsonl`;

// ---------------------------------------------------------------------------
// Main-thread hang watchdog
// ---------------------------------------------------------------------------

/** Default watchdog poll interval while the page runs the matrix. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * Extra slack over the in-page deadline before the watchdog declares the page
 * wedged. The in-page deadline is a setTimeout on the same main thread the
 * probe runs on, so a wedged main thread never fires it and the in-page
 * timeout cannot recover the run. The watchdog lives in the CLI process and
 * can.
 */
export const DEFAULT_GRACE_MS = 15_000;

/**
 * Liveness probe evaluated in the page. Returns the package currently being
 * run, or null when the page is idle. A page whose main thread is wedged
 * never answers at all — the evaluate call simply never resolves.
 */
export const HEARTBEAT_PROBE = () => window.__packageProgress ?? null;

/**
 * Whether a page that has been on the same package for `elapsedMs` should be
 * treated as hung.
 */
export const isHung = (elapsedMs, deadlineMs, graceMs = DEFAULT_GRACE_MS) =>
  elapsedMs > deadlineMs + graceMs;

/**
 * Result of one watchdog tick.
 *
 * - "ok": the page answered and is still working on the same package.
 * - "done": the page moved on to another package (or finished).
 * - "hung": the page did not answer, or answered but is far past the deadline.
 */
export const classifyHeartbeat = ({
  elapsedMs,
  deadlineMs,
  graceMs = DEFAULT_GRACE_MS,
  probeResult,
}) => {
  if (probeResult === "probe-hang") {
    return isHung(elapsedMs, deadlineMs, graceMs) ? "hung" : "ok";
  }
  if (probeResult?.current !== undefined && probeResult.current !== null) {
    // Still on the same package: only hung if far past the deadline.
    return isHung(elapsedMs, deadlineMs, graceMs) ? "hung" : "ok";
  }
  return "done";
};

/**
 * Merges resumed results (from a partial file) with fresh results, keeping
 * matrix order. Fresh results win on name collisions.
 */
export const mergeResults = (resumed, fresh, matrixOrder) => {
  const order = new Map(matrixOrder.map((name, i) => [name, i]));
  const byName = new Map();
  for (const r of [...resumed, ...fresh]) byName.set(r.name, r);
  return [...byName.values()].sort(
    (a, b) =>
      (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
};
