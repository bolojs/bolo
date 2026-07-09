import { describe, expect, it } from "vitest";
import { parse, resolve } from "./index.js";
import { readFixture } from "./test-utils.js";

describe("roundtrip parse → resolve", () => {
  it("produces installable lodash from every format", async () => {
    const fixtures = [
      { name: "npm", content: await readFixture("package-lock.v3.json"), format: "npm" as const },
      { name: "yarn-v1", content: await readFixture("yarn-v1.lock"), format: "yarn" as const },
      {
        name: "yarn-berry",
        content: await readFixture("yarn-berry.lock"),
        format: "yarn-berry" as const,
      },
      { name: "pnpm", content: await readFixture("pnpm-lock.v9.yaml"), format: "pnpm" as const },
      { name: "bun-text", content: await readFixture("bun.lock"), format: "bun-text" as const },
    ];

    for (const { name, content, format } of fixtures) {
      const graph = parse(content, format);
      const installable = resolve(graph);
      expect(
        installable.length,
        `${name} should yield at least one package`,
      ).toBeGreaterThanOrEqual(1);
      const lodash = installable.find((p) => p.name === "lodash");
      expect(lodash, `${name} should resolve lodash`).toBeDefined();
      expect(lodash?.version).toBe("4.17.21");
      expect(lodash?.url).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    }
  });
});
