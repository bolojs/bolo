import { describe, expect, it } from "vitest";
import { parse, resolve } from "../index.js";
import { readFixture } from "../test-utils.js";

describe("pnpm adapter", () => {
  it("parses pnpm-lock v9 and exposes lodash", async () => {
    const content = await readFixture("pnpm-lock.v9.yaml");
    const graph = parse(content, "pnpm");
    expect(graph.meta.format).toBe("pnpm");
    expect(graph.meta.version).toBe("9.0");
    const lodash = graph.packages.get("lodash@4.17.21");
    expect(lodash).toBeDefined();
    expect(lodash?.name).toBe("lodash");
    expect(lodash?.version).toBe("4.17.21");
    expect(lodash?.resolvedUrl).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    expect(lodash?.integrity).toMatch(/^sha512-/);
  });

  it("resolves installable packages", async () => {
    const content = await readFixture("pnpm-lock.v9.yaml");
    const graph = parse(content, "pnpm");
    const installable = resolve(graph, ".");
    expect(installable.length).toBeGreaterThanOrEqual(1);
    expect(installable.some((p) => p.name === "lodash")).toBe(true);
  });
});
