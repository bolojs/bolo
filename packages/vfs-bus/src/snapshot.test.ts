import { describe, it, expect, beforeEach } from "vitest";
import { VfsBus } from "./vfs-bus.js";

describe("VfsBus snapshot/restore", () => {
  let vfs: VfsBus;

  beforeEach(() => {
    vfs = new VfsBus();
  });

  it("snapshot captures current state", async () => {
    await vfs.writeFile("/a.txt", "aaa");
    await vfs.writeFile("/b.txt", "bbb");
    const snap = vfs.snapshot();
    expect(snap["/a.txt"]).toBeDefined();
    expect(snap["/b.txt"]).toBeDefined();
  });

  it("restore replaces filesystem state", async () => {
    await vfs.writeFile("/original.txt", "original");
    const snap = vfs.snapshot();

    await vfs.writeFile("/new-file.txt", "new");
    await vfs.rm("/original.txt");

    expect(await vfs.exists("/original.txt")).toBe(false);
    expect(await vfs.exists("/new-file.txt")).toBe(true);

    vfs.restore(snap);

    expect(await vfs.exists("/original.txt")).toBe(true);
    expect(await vfs.exists("/new-file.txt")).toBe(false);
    expect(await vfs.readFile("/original.txt")).toBe("original");
  });
});
