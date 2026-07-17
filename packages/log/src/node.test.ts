import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispose, getLogger } from "@logtape/logtape";
import { configureBoloLogging } from "./node.js";

describe("configureBoloLogging", () => {
  let dir: string;

  afterEach(async () => {
    await dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes structured JSONL to the run file and points latest.jsonl at it", async () => {
    dir = mkdtempSync(join(tmpdir(), "bolo-log-"));
    await configureBoloLogging({ logsDir: dir, runId: "test-run", consoleLevel: "fatal" });

    getLogger(["bolo", "test"]).info("hello {name}", { name: "world" });
    await dispose();

    expect(readlinkSync(join(dir, "latest.jsonl"))).toBe("test-run.jsonl");

    const lines = readFileSync(join(dir, "test-run.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.category).toEqual(["bolo", "test"]);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toContain("world");
  });

  it("routes records through a custom sink in addition to file/console", async () => {
    dir = mkdtempSync(join(tmpdir(), "bolo-log-"));
    const received: unknown[] = [];
    await configureBoloLogging({
      logsDir: dir,
      runId: "test-run",
      consoleLevel: "fatal",
      customSink: (record) => received.push(record),
    });

    getLogger(["bolo", "test"]).warn("custom sink check");

    expect(received).toHaveLength(1);
  });
});
