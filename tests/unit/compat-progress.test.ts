import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPartial,
  classifyHeartbeat,
  completedNames,
  DEFAULT_GRACE_MS,
  formatProgressLine,
  isHung,
  mergeResults,
  parsePartialResults,
  partialPathFor,
  pendingPackages,
  readPartialFile,
} from "../../apps/compat-harness/bin/progress-report.js";

describe("progress line formatting", () => {
  it("emits name, status and rounded duration", () => {
    const line = formatProgressLine({ name: "lodash", status: "pass", duration: 1234.56 });
    expect(JSON.parse(line)).toEqual({ name: "lodash", status: "pass", durationMs: 1235 });
  });

  it("includes the error when there is one", () => {
    const line = formatProgressLine({
      name: "webpack",
      status: "fail",
      error: "TIMEOUT after 60000ms",
      duration: 60001,
    });
    expect(JSON.parse(line)).toEqual({
      name: "webpack",
      status: "fail",
      durationMs: 60001,
      error: "TIMEOUT after 60000ms",
    });
  });

  it("omits the error when there is none", () => {
    const parsed = JSON.parse(formatProgressLine({ name: "a", status: "skip", duration: 1 }));
    expect("error" in parsed).toBe(false);
  });
});

describe("partial file parsing", () => {
  it("round-trips a result", () => {
    const text = `${formatProgressLine({ name: "a", status: "pass", duration: 5 })}\n`;
    const results = parsePartialResults(text);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("a");
    expect(results[0].status).toBe("pass");
    expect(results[0].duration).toBe(5);
  });

  it("drops a torn line from a killed run but keeps the rest", () => {
    const text =
      `${formatProgressLine({ name: "a", status: "pass", duration: 5 })}\n` +
      `${formatProgressLine({ name: "b", status: "pass", duration: 5 })}\n` +
      `{"name":"c","stat`;
    const results = parsePartialResults(text);
    expect(results.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("skips blank lines", () => {
    expect(parsePartialResults("\n\n  \n")).toEqual([]);
  });
});

describe("partial file IO", () => {
  it("appends one line per result and reads them back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bolo-progress-"));
    const path = join(dir, "out.json.partial.jsonl");
    await appendPartial(path, { name: "a", status: "pass", duration: 10 });
    await appendPartial(path, { name: "b", status: "fail", error: "boom", duration: 20 });

    const results = await readPartialFile(path);
    expect(results.map((r) => r.name)).toEqual(["a", "b"]);
    expect(results[1].error).toBe("boom");
  });

  it("returns an empty list when the partial file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bolo-progress-"));
    expect(await readPartialFile(join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("keeps earlier lines when the run is killed mid-write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bolo-progress-"));
    const path = join(dir, "out.json.partial.jsonl");
    await appendPartial(path, { name: "a", status: "pass", duration: 10 });
    // Simulate a kill during the write of the next line.
    await writeFile(path, `${await readFile(path, "utf8")}{"name":"b","stat`, "utf8");

    const results = await readPartialFile(path);
    expect(results.map((r) => r.name)).toEqual(["a"]);
  });
});

describe("resume selection", () => {
  const matrix = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("treats a completed package as done", () => {
    const done = completedNames([{ name: "a", status: "pass" }]);
    expect(done.has("a")).toBe(true);
  });

  it("retries timeouts because a timeout means a hung page, not an incompatible package", () => {
    const done = completedNames([
      { name: "a", status: "fail", error: "TIMEOUT after 60000ms (page main thread hung)" },
    ]);
    expect(done.has("a")).toBe(false);
  });

  it("keeps other failures as done", () => {
    const done = completedNames([{ name: "a", status: "fail", error: "build failed" }]);
    expect(done.has("a")).toBe(true);
  });

  it("filters the matrix down to the pending packages, preserving order", () => {
    const done = completedNames([{ name: "a", status: "pass" }]);
    expect(pendingPackages(matrix, done).map((p) => p.name)).toEqual(["b", "c"]);
  });

  it("returns an empty pending list when everything is done", () => {
    const done = completedNames([
      { name: "a", status: "pass" },
      { name: "b", status: "pass" },
      { name: "c", status: "pass" },
    ]);
    expect(pendingPackages(matrix, done)).toEqual([]);
  });
});

describe("partial path", () => {
  it("appends .partial.jsonl to the output path", () => {
    expect(partialPathFor("/tmp/out.json")).toBe("/tmp/out.json.partial.jsonl");
  });
});

describe("hang detection", () => {
  it("does not call a page hung before the deadline plus grace", () => {
    expect(isHung(60_000, 60_000)).toBe(false);
    expect(isHung(60_000 + DEFAULT_GRACE_MS, 60_000)).toBe(false);
  });

  it("calls a page hung past the deadline plus grace", () => {
    expect(isHung(60_000 + DEFAULT_GRACE_MS + 1, 60_000)).toBe(true);
  });

  it("classifies a page that stopped answering as hung only past the deadline", () => {
    expect(
      classifyHeartbeat({ elapsedMs: 1_000, deadlineMs: 60_000, probeResult: "probe-hang" }),
    ).toBe("ok");
    expect(
      classifyHeartbeat({
        elapsedMs: 60_000 + DEFAULT_GRACE_MS + 1,
        deadlineMs: 60_000,
        probeResult: "probe-hang",
      }),
    ).toBe("hung");
  });

  it("classifies a page answering on the same package past the deadline as hung", () => {
    expect(
      classifyHeartbeat({
        elapsedMs: 60_000 + DEFAULT_GRACE_MS + 1,
        deadlineMs: 60_000,
        probeResult: { current: "webpack" },
      }),
    ).toBe("hung");
  });

  it("classifies a page that moved to another package as done", () => {
    expect(
      classifyHeartbeat({
        elapsedMs: 120_000,
        deadlineMs: 60_000,
        probeResult: { current: null },
      }),
    ).toBe("done");
  });
});

describe("result merging", () => {
  it("keeps matrix order across resumed and fresh results", () => {
    const merged = mergeResults(
      [{ name: "a", status: "pass" }],
      [{ name: "b", status: "fail" }],
      ["a", "b", "c"],
    );
    expect(merged.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("lets a fresh result override a resumed one", () => {
    const merged = mergeResults(
      [{ name: "a", status: "fail", error: "stale" }],
      [{ name: "a", status: "pass" }],
      ["a"],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("pass");
  });

  it("sorts unknown packages last", () => {
    const merged = mergeResults(
      [{ name: "zzz", status: "pass" }],
      [{ name: "a", status: "pass" }],
      ["a"],
    );
    expect(merged.map((r) => r.name)).toEqual(["a", "zzz"]);
  });
});
