import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { bundleEntry } from "../src/bundle";

const seed = (vfs: VfsBus, path: string, contents: string) => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir && !vfs.hot.existsSync(dir)) vfs.hot.mkdirSync(dir, { recursive: true });
  vfs.hot.writeFileSync(path, contents);
};

describe("wasm-registry: native-addon variant alias plugin", () => {
  it("aliases a catalogued native-addon package to its WASM variant URL", async () => {
    const vfs = new VfsBus();
    // The installed argon2 package would die in node-gyp-build at module init;
    // the alias must win before the VFS tree is even read.
    seed(
      vfs,
      "/app/node_modules/argon2/package.json",
      JSON.stringify({ name: "argon2", version: "0.41.1", main: "index.js" }),
    );
    seed(
      vfs,
      "/app/node_modules/argon2/index.js",
      "throw new Error('node-gyp-build: No native build was found');",
    );
    seed(vfs, "/app/src/entry.ts", "import argon2 from 'argon2'; void argon2;");

    const { code, warnings } = await bundleEntry("/app/src/entry.ts", { vfs, cwd: "/app" });

    expect(warnings).toEqual([]);
    // The alias externalizes the import — the installed index.js never links.
    expect(code).toContain("https://esm.sh/argon2-wasm@0.9.0");
    // The installed package's own entry must not be linked.
    expect(code).not.toContain("node-gyp-build");
    expect(code).not.toContain("No native build was found");
  });

  it("leaves subpath imports of a catalogued package untouched", async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      "/app/node_modules/argon2/package.json",
      JSON.stringify({ name: "argon2", version: "0.41.1", main: "index.js" }),
    );
    seed(vfs, "/app/node_modules/argon2/hash.js", "export default 1;");
    seed(vfs, "/app/src/entry.ts", "import h from 'argon2/hash'; void h;");

    const { code } = await bundleEntry("/app/src/entry.ts", { vfs, cwd: "/app" });

    // No variant ships `argon2/hash` — the subpath is left to normal resolution.
    expect(code).not.toContain("esm.sh/argon2-wasm");
  });

  it("does not alias packages outside the curated table", async () => {
    const vfs = new VfsBus();
    seed(
      vfs,
      "/app/node_modules/lodash/package.json",
      JSON.stringify({ name: "lodash", version: "4.17.21", main: "index.js" }),
    );
    seed(vfs, "/app/node_modules/lodash/index.js", "export default 1;");
    seed(vfs, "/app/src/entry.ts", "import _ from 'lodash'; void _;");

    const { code } = await bundleEntry("/app/src/entry.ts", { vfs, cwd: "/app" });

    expect(code).not.toContain("esm.sh");
  });
});
