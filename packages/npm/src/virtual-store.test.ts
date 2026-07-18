import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import type { ResolvedGraph, ResolvedGraphPackage } from "@unjs/lockfile";
import { materializeVirtualStore } from "./virtual-store.js";

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

/** Fake fetch+extract: writes a minimal package.json so tests can verify identity via readFile. */
const fakeFetchAndExtract =
  (vfs: VfsBus, fail: Set<string> = new Set()) =>
  async (p: ResolvedGraphPackage, targetDir: string) => {
    if (fail.has(`${p.name}@${p.version}`)) {
      throw new Error(`fetch failed for ${p.name}@${p.version}`);
    }
    vfs.hot.mkdirSync(targetDir, { recursive: true });
    vfs.hot.writeFileSync(
      `${targetDir}/package.json`,
      JSON.stringify({ name: p.name, version: p.version, bin: p.bin }),
    );
  };

const readJson = (vfs: VfsBus, path: string): any =>
  JSON.parse(vfs.hot.readFileSync(path, "utf8") as string);

describe("materializeVirtualStore", () => {
  it("keeps both versions of a diamond dependency, each with its own symlinked copy", async () => {
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { pkgA: "pkgA@1.0.0", pkgB: "pkgB@1.0.0" },
      packages: new Map([
        ["pkgA@1.0.0", pkg({ name: "pkgA", depPath: "pkgA@1.0.0", resolvedDependencies: { lodash: "lodash@3.0.0" } })],
        ["pkgB@1.0.0", pkg({ name: "pkgB", depPath: "pkgB@1.0.0", resolvedDependencies: { lodash: "lodash@4.0.0" } })],
        ["lodash@3.0.0", pkg({ name: "lodash", version: "3.0.0", depPath: "lodash@3.0.0" })],
        ["lodash@4.0.0", pkg({ name: "lodash", version: "4.0.0", depPath: "lodash@4.0.0" })],
      ]),
    };

    await materializeVirtualStore({ vfs, cwd: "/app", graph, fetchAndExtract: fakeFetchAndExtract(vfs) });

    expect(vfs.hot.existsSync("/app/node_modules/.bolo/lodash@3.0.0/node_modules/lodash")).toBe(true);
    expect(vfs.hot.existsSync("/app/node_modules/.bolo/lodash@4.0.0/node_modules/lodash")).toBe(true);

    const aLodash = readJson(vfs, "/app/node_modules/.bolo/pkgA@1.0.0/node_modules/lodash/package.json");
    const bLodash = readJson(vfs, "/app/node_modules/.bolo/pkgB@1.0.0/node_modules/lodash/package.json");
    expect(aLodash.version).toBe("3.0.0");
    expect(bLodash.version).toBe("4.0.0");

    expect(vfs.hot.lstatSync("/app/node_modules/pkgA").isSymbolicLink()).toBe(true);
    expect(readJson(vfs, "/app/node_modules/pkgA/package.json").name).toBe("pkgA");
    expect(readJson(vfs, "/app/node_modules/pkgB/package.json").name).toBe("pkgB");
  });

  it("links a peer dependency that is satisfied elsewhere in the graph, and warns when unsatisfied", async () => {
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { consumer: "consumer@1.0.0", peerLib: "peerLib@1.2.0" },
      packages: new Map([
        [
          "consumer@1.0.0",
          pkg({
            name: "consumer",
            depPath: "consumer@1.0.0",
            peerDependencies: { peerLib: "^1.0.0", missingPeer: "^2.0.0" },
          }),
        ],
        ["peerLib@1.2.0", pkg({ name: "peerLib", version: "1.2.0", depPath: "peerLib@1.2.0" })],
      ]),
    };

    const warnings: string[] = [];
    await materializeVirtualStore({
      vfs,
      cwd: "/app",
      graph,
      fetchAndExtract: fakeFetchAndExtract(vfs),
      onWarn: (m) => warnings.push(m),
    });

    const linkedPeer = readJson(
      vfs,
      "/app/node_modules/.bolo/consumer@1.0.0/node_modules/peerLib/package.json",
    );
    expect(linkedPeer.version).toBe("1.2.0");
    expect(warnings.some((w) => w.includes("missingPeer") && w.includes("unmet peer"))).toBe(true);
  });

  it("tolerates an optional dependency whose fetch fails, skipping it and its links", async () => {
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { app: "app@1.0.0" },
      packages: new Map([
        ["app@1.0.0", pkg({ name: "app", depPath: "app@1.0.0", resolvedDependencies: { flaky: "flaky@1.0.0" } })],
        ["flaky@1.0.0", pkg({ name: "flaky", depPath: "flaky@1.0.0", optional: true })],
      ]),
    };

    const warnings: string[] = [];
    await materializeVirtualStore({
      vfs,
      cwd: "/app",
      graph,
      fetchAndExtract: fakeFetchAndExtract(vfs, new Set(["flaky@1.0.0"])),
      onWarn: (m) => warnings.push(m),
    });

    expect(vfs.hot.existsSync("/app/node_modules/.bolo/app@1.0.0/node_modules/flaky")).toBe(false);
    expect(warnings.some((w) => w.includes("flaky") && w.includes("skipping"))).toBe(true);
    expect(readJson(vfs, "/app/node_modules/app/package.json").name).toBe("app");
  });

  it("rejects when a non-optional dependency's fetch fails", async () => {
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { app: "app@1.0.0" },
      packages: new Map([["app@1.0.0", pkg({ name: "app", depPath: "app@1.0.0" })]]),
    };

    await expect(
      materializeVirtualStore({
        vfs,
        cwd: "/app",
        graph,
        fetchAndExtract: fakeFetchAndExtract(vfs, new Set(["app@1.0.0"])),
      }),
    ).rejects.toThrow("fetch failed for app@1.0.0");
  });

  it("links .bin entries at both root and per-package node_modules", async () => {
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { cli: "cli@1.0.0" },
      packages: new Map([
        ["cli@1.0.0", pkg({ name: "cli", depPath: "cli@1.0.0", bin: { cli: "bin/cli.js" } })],
      ]),
    };

    await materializeVirtualStore({ vfs, cwd: "/app", graph, fetchAndExtract: fakeFetchAndExtract(vfs) });

    expect(vfs.hot.lstatSync("/app/node_modules/.bin/cli").isSymbolicLink()).toBe(true);
    expect(vfs.hot.readlinkSync("/app/node_modules/.bin/cli")).toBe("/app/node_modules/cli/bin/cli.js");
  });

  it("re-materializes without throwing when a package/root symlink from a prior install already exists", async () => {
    // Regression test: memfs's rmSync/existsSync follow a directory symlink's
    // target rather than acting on the link itself, so a naive
    // existsSync-then-rmSync guard leaves the stale link entry behind and the
    // next symlinkSync at that path throws EEXIST. This reproduces a real
    // "npm install" run a second time in the same session (found via manual
    // QA against the live demo).
    const vfs = new VfsBus();

    const graph: ResolvedGraph = {
      rootDependencies: { cli: "cli@1.0.0" },
      packages: new Map([
        ["cli@1.0.0", pkg({ name: "cli", depPath: "cli@1.0.0", bin: { cli: "bin/cli.js" } })],
      ]),
    };

    await materializeVirtualStore({ vfs, cwd: "/app", graph, fetchAndExtract: fakeFetchAndExtract(vfs) });
    await expect(
      materializeVirtualStore({ vfs, cwd: "/app", graph, fetchAndExtract: fakeFetchAndExtract(vfs) }),
    ).resolves.not.toThrow();

    expect(vfs.hot.lstatSync("/app/node_modules/cli").isSymbolicLink()).toBe(true);
    expect(readJson(vfs, "/app/node_modules/cli/package.json").name).toBe("cli");
    expect(vfs.hot.readlinkSync("/app/node_modules/.bin/cli")).toBe("/app/node_modules/cli/bin/cli.js");
  });
});
