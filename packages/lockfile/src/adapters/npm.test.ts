import { describe, expect, it } from "vitest";
import { parse, resolve } from "../index.js";
import { readFixture } from "../test-utils.js";

describe("npm adapter", () => {
  it("parses package-lock v3 and exposes lodash", async () => {
    const content = await readFixture("package-lock.v3.json");
    const graph = parse(content, "npm");
    expect(graph.meta.format).toBe("npm");
    expect(graph.meta.version).toBe("3");
    const lodash = graph.packages.get("node_modules/lodash");
    expect(lodash).toBeDefined();
    expect(lodash?.name).toBe("lodash");
    expect(lodash?.version).toBe("4.17.21");
    expect(lodash?.resolvedUrl).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    expect(lodash?.integrity).toMatch(/^sha512-/);
  });

  it("resolves installable packages", async () => {
    const content = await readFixture("package-lock.v3.json");
    const graph = parse(content, "npm");
    const installable = resolve(graph, ".");
    expect(installable.length).toBeGreaterThanOrEqual(1);
    expect(installable.some((p) => p.name === "lodash")).toBe(true);
  });
});
