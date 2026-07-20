import { describe, expect, it } from "vitest";
import { parse, resolve } from "../index.js";
import { readFixture } from "../test-utils.js";

describe("yarn adapters", () => {
  it("parses yarn v1 lockfile", async () => {
    const content = await readFixture("yarn-v1.lock");
    const graph = parse(content, "yarn");
    expect(graph.meta.format).toBe("yarn");
    expect(graph.packages.size).toBeGreaterThanOrEqual(1);
    const lodash = Array.from(graph.packages.values()).find((p) => p.name === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash?.version).toBe("4.17.21");
    expect(lodash?.resolvedUrl).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
  });

  it("parses yarn berry lockfile", async () => {
    const content = await readFixture("yarn-berry.lock");
    const graph = parse(content, "yarn-berry");
    expect(graph.meta.format).toBe("yarn-berry");
    expect(graph.meta.version).toBe("8");
    const lodash = Array.from(graph.packages.values()).find((p) => p.name === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash?.version).toBe("4.17.21");
  });

  it("resolves yarn v1 installable packages", async () => {
    const content = await readFixture("yarn-v1.lock");
    const graph = parse(content, "yarn");
    const installable = resolve(graph);
    expect(installable.length).toBeGreaterThanOrEqual(1);
    expect(installable.some((p) => p.name === "lodash")).toBe(true);
  });
});
