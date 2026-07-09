import { describe, it, expect, beforeEach } from "vitest";
import { VfsBus, type DirEnt } from "./vfs-bus.js";

describe("VfsBus", () => {
  let vfs: VfsBus;

  beforeEach(() => {
    vfs = new VfsBus();
  });

  it("writeFile and readFile round-trip", async () => {
    await vfs.writeFile("/hello.txt", "world");
    const data = await vfs.readFile("/hello.txt");
    expect(data).toBe("world");
  });

  it("writeFile with Uint8Array", async () => {
    await vfs.writeFile("/binary.bin", new Uint8Array([1, 2, 3]));
    const data = await vfs.readFile("/binary.bin");
    expect(data).toBe("\x01\x02\x03");
  });

  it("mkdir creates directories", async () => {
    await vfs.mkdir("/src");
    const exists = await vfs.exists("/src");
    expect(exists).toBe(true);
  });

  it("mkdir recursive creates nested directories", async () => {
    await vfs.mkdir("/a/b/c", { recursive: true });
    const exists = await vfs.exists("/a/b/c");
    expect(exists).toBe(true);
  });

  it("exists returns false for missing files", async () => {
    const exists = await vfs.exists("/nope");
    expect(exists).toBe(false);
  });

  it("readdir returns directory entries", async () => {
    await vfs.mkdir("/src");
    await vfs.writeFile("/src/a.ts", "a");
    await vfs.writeFile("/src/b.ts", "b");
    const entries = await vfs.readdir("/src");
    expect(entries.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("rm removes files", async () => {
    await vfs.writeFile("/tmp.txt", "x");
    await vfs.rm("/tmp.txt");
    const exists = await vfs.exists("/tmp.txt");
    expect(exists).toBe(false);
  });

  it("rm recursive removes directories", async () => {
    await vfs.mkdir("/del", { recursive: true });
    await vfs.writeFile("/del/f.txt", "f");
    await vfs.rm("/del", { recursive: true });
    const exists = await vfs.exists("/del");
    expect(exists).toBe(false);
  });

  describe("rename", () => {
    it("renames file successfully", async () => {
      await vfs.writeFile("/old.txt", "content");
      await vfs.rename("/old.txt", "/new.txt");
      const oldExists = await vfs.exists("/old.txt");
      const newExists = await vfs.exists("/new.txt");
      expect(oldExists).toBe(false);
      expect(newExists).toBe(true);
      const data = await vfs.readFile("/new.txt");
      expect(data).toBe("content");
    });

    it("throws ENOENT when source does not exist", async () => {
      await expect(vfs.rename("/nonexistent.txt", "/dest.txt")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("throws EEXIST when destination exists", async () => {
      await vfs.writeFile("/source.txt", "source");
      await vfs.writeFile("/dest.txt", "dest");
      await expect(vfs.rename("/source.txt", "/dest.txt")).rejects.toMatchObject({
        code: "EEXIST",
      });
    });

    it("emits rename event", async () => {
      await vfs.writeFile("/old.txt", "content");
      let capturedPath = "";
      vfs.on("rename", ({ path }) => {
        capturedPath = path;
      });
      await vfs.rename("/old.txt", "/new.txt");
      expect(capturedPath).toBe("/old.txt");
    });

    it("notifies watchers: unlink on old path, add on new path", async () => {
      await vfs.writeFile("/old.txt", "content");
      const events: Array<{ path: string; event: string }> = [];
      vfs.watch("**", (path, event) => events.push({ path, event }));
      await vfs.rename("/old.txt", "/new.txt");
      expect(events).toContainEqual({ path: "/old.txt", event: "unlink" });
      expect(events).toContainEqual({ path: "/new.txt", event: "add" });
    });
  });

  describe("readdir with withFileTypes", () => {
    it("returns DirEnt[] with withFileTypes: true", async () => {
      await vfs.mkdir("/test");
      await vfs.writeFile("/test/file.txt", "file");
      await vfs.mkdir("/test/subdir");
      const entries = (await vfs.readdir("/test", { withFileTypes: true })) as DirEnt[];
      expect(entries).toHaveLength(2);
      const file = entries.find((e) => e.name === "file.txt");
      const dir = entries.find((e) => e.name === "subdir");
      expect(file).toBeDefined();
      expect(dir).toBeDefined();
      expect(file!.isFile()).toBe(true);
      expect(file!.isDirectory()).toBe(false);
      expect(dir!.isFile()).toBe(false);
      expect(dir!.isDirectory()).toBe(true);
    });

    it("returns string[] by default (backward compatible)", async () => {
      await vfs.mkdir("/test");
      await vfs.writeFile("/test/a.txt", "a");
      const entries = await vfs.readdir("/test");
      expect(entries).toEqual(["a.txt"]);
      expect(typeof entries[0]).toBe("string");
    });
  });
});
