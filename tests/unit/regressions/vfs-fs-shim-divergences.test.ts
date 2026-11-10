import { describe, it, expect } from "vitest";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { VfsBus } from "@bolojs/fs";
import { createFsShim } from "@bolojs/node-runtime-shims";

// Counterexamples found by packages/node-runtime-shims/test/fs-shim.model.test.ts
// and by reading the shim. Some are deterministic (no seed) since they hold on
// every input of the recorded shape.
describe("known VfsBus/fs-shim vs node:fs divergences", () => {
  it.fails("[seed any] stat on missing path synthesizes flags instead of ENOENT", async () => {
    const shim = createFsShim(new VfsBus());
    await expect(shim.stat("/missing")).rejects.toThrow(); // shim returns all-false FsStat
  });

  it.fails("[seed any] readFile without encoding returns string, node returns bytes", async () => {
    const shim = createFsShim(new VfsBus());
    await shim.writeFile("/x.txt", "hello");
    const data = await shim.readFile("/x.txt");
    expect(data).toBeInstanceOf(Uint8Array); // shim returns "hello" (string)
  });

  it.fails("[seed any] writeFile auto-creates parent dirs where node throws ENOENT", async () => {
    const shim = createFsShim(new VfsBus());
    const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "vfs-reg-"));
    try {
      const shimThrew = await shim.writeFile("/no/such/dir/f.txt", "x").then(
        () => false,
        () => true,
      );
      const nodeThrew = await Promise.resolve()
        .then(() => nodeFs.writeFileSync(nodePath.join(tmp, "no/such/dir/f.txt"), "x"))
        .then(
          () => false,
          () => true,
        );
      expect(shimThrew).toBe(nodeThrew); // shim false (writes), node true (ENOENT)
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.fails("[seed any] vfs.rename refuses to overwrite existing target like node", async () => {
    const vfs = new VfsBus();
    await vfs.writeFile("/a.txt", "1");
    await vfs.writeFile("/b.txt", "2");
    await expect(vfs.rename("/a.txt", "/b.txt")).resolves.toBeUndefined();
    // node fs.rename replaces the file silently; vfs.rename throws EEXIST
  });

  it.fails("[seed -1855445626] memfs mkdir recursive on existing file silently succeeds", () => {
    const vfs = new VfsBus();
    vfs.hot.writeFileSync("/f.txt", "x");
    expect(() => vfs.hot.mkdirSync("/f.txt", { recursive: true })).toThrow();
    // node mkdirSync(path,{recursive:true}) throws EEXIST on a file
  });

  it.fails("[seed any] memfs rename allows cross-type targets node rejects", () => {
    const vfs = new VfsBus();
    const shim = createFsShim(vfs);
    vfs.hot.writeFileSync("/f.txt", "x");
    vfs.hot.mkdirSync("/d");
    // node: EISDIR renaming a file onto a dir, ENOTDIR a dir onto a file —
    // memfs happily performs both.
    expect(() => shim.renameSync("/f.txt", "/d")).toThrow();
    expect(() => shim.renameSync("/d", "/f.txt")).toThrow();
  });
});
