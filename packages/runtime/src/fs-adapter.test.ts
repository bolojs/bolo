import { describe, expect, it } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import { createFileSystem } from "./fs-adapter.js";

describe("createFileSystem", () => {
  it("should read a file as string", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/a.txt", "hello");
    expect(await fs.readFile("/a.txt")).toBe("hello");
  });

  it("should read a Uint8Array file as string", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/b.txt", new TextEncoder().encode("world"));
    expect(await fs.readFile("/b.txt")).toBe("world");
  });

  it("should write a string file", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await fs.writeFile("/c.txt", "content");
    expect(await vfs.readFile("/c.txt")).toBe("content");
  });

  it("should write a Uint8Array file", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    const data = new TextEncoder().encode("binary");
    await fs.writeFile("/d.bin", data);
    expect(await vfs.readFile("/d.bin")).toBe("binary");
  });

  it("should mkdir", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await fs.mkdir("/mydir");
    expect(await vfs.exists("/mydir")).toBe(true);
  });

  it("should mkdir recursively", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await fs.mkdir("/a/b/c", { recursive: true });
    expect(await vfs.exists("/a/b/c")).toBe(true);
  });

  it("should rm a file", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/e.txt", "x");
    await fs.rm("/e.txt");
    expect(await vfs.exists("/e.txt")).toBe(false);
  });

  it("should rm a directory recursively", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.mkdir("/delme", { recursive: true });
    await vfs.writeFile("/delme/f.txt", "x");
    await fs.rm("/delme");
    expect(await vfs.exists("/delme")).toBe(false);
  });

  it("should readdir returning string array", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/dir1/a.txt", "a");
    await vfs.mkdir("/dir1/sub", { recursive: true });
    const entries = await fs.readdir("/dir1");
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toContain("a.txt");
    expect(entries).toContain("sub");
  });

  it("should readdir with withFileTypes returning DirEnt array", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/dir2/file.txt", "a");
    await vfs.mkdir("/dir2/folder", { recursive: true });
    const entries = await fs.readdir("/dir2", { withFileTypes: true });
    const fileEnt = (
      entries as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    ).find((e) => e.name === "file.txt");
    const dirEnt = (
      entries as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
    ).find((e) => e.name === "folder");
    expect(fileEnt?.isFile()).toBe(true);
    expect(fileEnt?.isDirectory()).toBe(false);
    expect(dirEnt?.isFile()).toBe(false);
    expect(dirEnt?.isDirectory()).toBe(true);
  });

  it("should rename a file", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/old.txt", "data");
    await fs.rename("/old.txt", "/new.txt");
    expect(await vfs.exists("/old.txt")).toBe(false);
    expect(await vfs.readFile("/new.txt")).toBe("data");
  });

  it("should throw ENOENT for missing file read", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await expect(fs.readFile("/missing.txt")).rejects.toThrow("ENOENT");
  });

  it("should throw EEXIST for rename to existing destination", async () => {
    const vfs = new VfsBus();
    const fs = createFileSystem(vfs);
    await vfs.writeFile("/src.txt", "a");
    await vfs.writeFile("/dst.txt", "b");
    await expect(fs.rename("/src.txt", "/dst.txt")).rejects.toThrow("EEXIST");
  });
});
