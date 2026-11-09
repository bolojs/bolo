import { describe, expect, it } from "vitest";
import { resolveGraph } from "./resolve.js";
import type { LockedPackage, LockfileGraph } from "./graph.js";

const pkg = (
  overrides: Partial<LockedPackage> & Pick<LockedPackage, "name" | "version" | "depPath">,
): LockedPackage => ({
  dev: false,
  optional: false,
  peerDependencies: {},
  dependencies: {},
  bin: {},
  ...overrides,
});

describe("resolveGraph", () => {
  it("keeps multiple versions of the same package and resolves each edge to its own nested copy", () => {
    // app -> pkgA -> lodash@3, app -> pkgB -> lodash@4 (classic diamond, npm v3 nesting)
    const graph: LockfileGraph = {
      meta: { format: "npm", version: "3" },
      catalogs: {},
      importers: [
        {
          cwd: ".",
          dependencies: { pkgA: "1.0.0", pkgB: "1.0.0" },
          devDependencies: {},
          optionalDependencies: {},
          peerDependencies: {},
        },
      ],
      packages: new Map([
        [
          "node_modules/pkgA",
          pkg({
            name: "pkgA",
            version: "1.0.0",
            depPath: "node_modules/pkgA",
            dependencies: { lodash: "^3.0.0" },
          }),
        ],
        [
          "node_modules/pkgB",
          pkg({
            name: "pkgB",
            version: "1.0.0",
            depPath: "node_modules/pkgB",
            dependencies: { lodash: "^4.0.0" },
          }),
        ],
        [
          "node_modules/pkgA/node_modules/lodash",
          pkg({
            name: "lodash",
            version: "3.10.1",
            depPath: "node_modules/pkgA/node_modules/lodash",
          }),
        ],
        [
          "node_modules/pkgB/node_modules/lodash",
          pkg({
            name: "lodash",
            version: "4.17.21",
            depPath: "node_modules/pkgB/node_modules/lodash",
          }),
        ],
      ]),
    };

    const resolved = resolveGraph(graph, ".");

    expect(resolved.rootDependencies.pkgA).toBe("node_modules/pkgA");
    expect(resolved.rootDependencies.pkgB).toBe("node_modules/pkgB");

    const pkgA = resolved.packages.get("node_modules/pkgA")!;
    const pkgB = resolved.packages.get("node_modules/pkgB")!;
    expect(pkgA.resolvedDependencies.lodash).toBe("node_modules/pkgA/node_modules/lodash");
    expect(pkgB.resolvedDependencies.lodash).toBe("node_modules/pkgB/node_modules/lodash");

    expect(resolved.packages.get("node_modules/pkgA/node_modules/lodash")!.version).toBe("3.10.1");
    expect(resolved.packages.get("node_modules/pkgB/node_modules/lodash")!.version).toBe("4.17.21");
  });

  it("falls back to name+semver matching for flat depPath formats (pnpm/yarn/bun)", () => {
    const graph: LockfileGraph = {
      meta: { format: "yarn", version: "1" },
      catalogs: {},
      importers: [
        {
          cwd: ".",
          dependencies: { express: "^4.0.0" },
          devDependencies: {},
          optionalDependencies: {},
          peerDependencies: {},
        },
      ],
      packages: new Map([
        [
          "express@4.18.0",
          pkg({
            name: "express",
            version: "4.18.0",
            depPath: "express@4.18.0",
            dependencies: { "body-parser": "^1.20.0" },
          }),
        ],
        [
          "body-parser@1.20.2",
          pkg({ name: "body-parser", version: "1.20.2", depPath: "body-parser@1.20.2" }),
        ],
      ]),
    };

    const resolved = resolveGraph(graph, ".");
    expect(resolved.rootDependencies.express).toBe("express@4.18.0");
    const express = resolved.packages.get("express@4.18.0")!;
    expect(express.resolvedDependencies["body-parser"]).toBe("body-parser@1.20.2");
  });
});
