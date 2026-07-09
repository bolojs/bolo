import { describe, expect, it } from "vitest";
import { parse, resolve } from "../index.js";
import { readFixture } from "../test-utils.js";

describe("bun text adapter", () => {
  it("parses bun.lock JSONC and exposes lodash", async () => {
    const content = await readFixture("bun.lock");
    const graph = parse(content, "bun-text");
    expect(graph.meta.format).toBe("bun-text");
    const lodash = graph.packages.get("lodash@4.17.21");
    expect(lodash).toBeDefined();
    expect(lodash?.name).toBe("lodash");
    expect(lodash?.version).toBe("4.17.21");
    expect(lodash?.resolvedUrl).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    expect(lodash?.integrity).toMatch(/^sha512-/);
  });

  it("resolves installable packages", async () => {
    const content = await readFixture("bun.lock");
    const graph = parse(content, "bun-text");
    const installable = resolve(graph);
    expect(installable.length).toBeGreaterThanOrEqual(1);
    expect(installable.some((p) => p.name === "lodash")).toBe(true);
  });
});
