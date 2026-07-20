import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { materializeVirtualStore } from "@bolojs/pm";
import type { ResolvedGraph, ResolvedGraphPackage } from "@bolojs/pm";
import { bundleEntry } from "../src/bundle";

const pkg = (overrides: Partial<ResolvedGraphPackage> = {}): ResolvedGraphPackage => ({
  name: "pkg",
  version: "1.0.0",
  depPath: "pkg@1.0.0",
  resolvedUrl: "https://reg/pkg.tgz",
  integrity: "",
  dev: false,
  optional: false,
  peerDependencies: {},
  dependencies: {},
  bin: {},
  resolvedDependencies: {},
  ...overrides,
});

/**
 * Fake fetch+extract: writes a package.json (main: index.js) plus an index.js
 * whose content is supplied by the test, so it can encode which resolved
 * version actually got bundled.
 */
const fakeFetchAndExtract =
  (vfs: VfsBus, indexSource: (p: ResolvedGraphPackage) => string) =>
  async (p: ResolvedGraphPackage, targetDir: string) => {
    vfs.hot.mkdirSync(targetDir, { recursive: true });
    vfs.hot.writeFileSync(
      `${targetDir}/package.json`,
      JSON.stringify({ name: p.name, version: p.version, main: "index.js" }),
    );
    vfs.hot.writeFileSync(`${targetDir}/index.js`, indexSource(p));
  };

describe("bundleEntry + materializeVirtualStore", () => {
  it("bundles an app depending on two incompatible versions of the same package (diamond dep)", async () => {
    const vfs = new VfsBus();

    // app -> pkgA -> shared@1.5.0
    //     -> pkgB -> shared@2.0.0
    const graph: ResolvedGraph = {
      rootDependencies: { pkgA: "pkgA@1.0.0", pkgB: "pkgB@1.0.0" },
      packages: new Map([
        [
          "pkgA@1.0.0",
          pkg({ name: "pkgA", depPath: "pkgA@1.0.0", resolvedDependencies: { shared: "shared@1.5.0" } }),
        ],
        [
          "pkgB@1.0.0",
          pkg({ name: "pkgB", depPath: "pkgB@1.0.0", resolvedDependencies: { shared: "shared@2.0.0" } }),
        ],
        ["shared@1.5.0", pkg({ name: "shared", version: "1.5.0", depPath: "shared@1.5.0" })],
        ["shared@2.0.0", pkg({ name: "shared", version: "2.0.0", depPath: "shared@2.0.0" })],
      ]),
    };

    await materializeVirtualStore({
      vfs,
      cwd: "/app",
      graph,
      fetchAndExtract: fakeFetchAndExtract(vfs, (p) => {
        if (p.name === "shared") return `export const sharedVersion = "${p.version}";`;
        return `export { sharedVersion as ${p.name}Version } from "shared";`;
      }),
    });

    vfs.hot.mkdirSync("/app/src", { recursive: true });
    vfs.hot.writeFileSync(
      "/app/src/entry.ts",
      [
        "import { pkgAVersion } from 'pkgA';",
        "import { pkgBVersion } from 'pkgB';",
        "console.log(pkgAVersion, pkgBVersion);",
      ].join("\n"),
    );

    const { code, warnings } = await bundleEntry("/app/src/entry.ts", { vfs });

    expect(warnings).toEqual([]);
    // Both versions must be present in the bundle — proof the virtual store's
    // per-package symlinked node_modules (not a flat, first-wins layout) is
    // what the bundler actually resolved against.
    expect(code).toContain("1.5.0");
    expect(code).toContain("2.0.0");
  });
});
