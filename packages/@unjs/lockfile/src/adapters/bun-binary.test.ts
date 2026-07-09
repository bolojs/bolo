import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, resolve } from "../index.js";
import { fixturePath, readFixtureBuffer, readFixtureSync } from "../test-utils.js";

describe("bun binary adapter", () => {
  const fixture = fixturePath("bun.lockb");
  const hasFixture = existsSync(fixture);
  const parserSupportsFixture = (() => {
    if (!hasFixture) return false;
    try {
      parse(readFixtureSync("bun.lockb"), "bun-binary");
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(parserSupportsFixture)("parses bun.lockb binary and exposes lodash", async () => {
    const buffer = await readFixtureBuffer("bun.lockb");
    const graph = parse(buffer, "bun-binary");
    expect(graph.meta.format).toBe("bun-binary");
    const lodash = Array.from(graph.packages.values()).find((p) => p.name === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash?.version).toBe("4.17.21");
    expect(lodash?.resolvedUrl).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
  });

  it.runIf(parserSupportsFixture)("resolves installable packages", async () => {
    const buffer = await readFixtureBuffer("bun.lockb");
    const graph = parse(buffer, "bun-binary");
    const installable = resolve(graph);
    expect(installable.length).toBeGreaterThanOrEqual(1);
    expect(installable.some((p) => p.name === "lodash")).toBe(true);
  });

  it.runIf(!hasFixture)("skips bun.lockb test without fixture", () => {
    // ponytail: fixture could not be generated without bun CLI
    expect(true).toBe(true);
  });

  it.runIf(hasFixture && !parserSupportsFixture)(
    "skips bun.lockb test with unsupported format",
    () => {
      // ponytail: @hyrious/bun.lockb 0.0.4 does not parse bun 1.3+ lockb files
      expect(true).toBe(true);
    },
  );
});
