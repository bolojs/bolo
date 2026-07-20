import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { PackageManager } from "./package-manager.js";

/**
 * E2E network test: hit the real npm registry, download a tarball, and verify
 * the full install pipeline (resolver → extractor → virtual store → lockfile).
 *
 * Fixture choice: `ms@2.1.3`. The plan example uses `ms@^2`; we pin exact to
 * avoid flakiness from future 2.x releases. `ms` is a tiny, single-file CJS
 * package with no dependencies, so the test exercises the CJS path without
 * dragging in transitive resolution.
 */

// Skip the test only when explicitly disabled. In offline environments, run:
//   SKIP_NETWORK_TESTS=1 pnpm --filter @bolojs/pm test
const SKIP_NETWORK_TESTS = process.env.SKIP_NETWORK_TESTS === "1";

describe("e2e @e2e", () => {
  it.skipIf(SKIP_NETWORK_TESTS)(
    "installs ms@2.1.3 from the real npm registry end-to-end",
    async () => {
      const vfs = new VfsBus();
      const pm = new PackageManager({ vfs, cwd: "/" });

      await pm.install(["ms@2.1.3"]);

      // 1. Lockfile was written and records the resolved version.
      const lockContent = (await vfs.readFile("/package-lock.json")) as string;
      const lock = JSON.parse(lockContent);
      expect(lock.lockfileVersion).toBe(3);
      expect(lock.packages["node_modules/ms"]).toBeDefined();
      expect(lock.packages["node_modules/ms"].version).toBe("2.1.3");

      // 2. Virtual store has the package under its versioned slot.
      const installedPkg = JSON.parse(
        (await vfs.readFile("/node_modules/ms/package.json")) as string,
      );
      const version = installedPkg.version;
      expect(version).toBe("2.1.3");
      expect(vfs.hot.existsSync(`/node_modules/.bolo/ms@${version}`)).toBe(true);
      expect(vfs.hot.existsSync(`/node_modules/.bolo/ms@${version}/node_modules/ms/index.js`)).toBe(
        true,
      );

      // 3. The package is symlinked into the root node_modules layout.
      expect(vfs.hot.existsSync("/node_modules/ms/index.js")).toBe(true);
      const indexJs = (await vfs.readFile("/node_modules/ms/index.js")) as string;
      expect(indexJs).toContain("module.exports");

      // 4. The CJS→ESM facade and import-map assertion are intentionally skipped
      // here. The facade lives in the runtime/bundler layer, not in @bolojs/pm,
      // so importing from the memfs-backed VFS is not directly exercisable from
      // this package's unit tests.
    },
    30000,
  );
});
