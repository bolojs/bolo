import { describe, it, expect } from "vitest";
import { createPathShim } from "../src/path.ts";

describe("node-web-shims: path", () => {
  it("should match node:path type shape", () => {
    const shim = createPathShim();
    const _nodePath: typeof import("node:path") = shim;
    expect(_nodePath).toBeDefined();
  });

  it("exposes posix and win32 as separate implementations", () => {
    const shim = createPathShim();
    expect(shim.posix.sep).toBe("/");
    expect(shim.win32.sep).toBe("\\");
    expect(shim.sep).toBe("/");
    expect(shim.delimiter).toBe(":");
    expect(shim.win32.delimiter).toBe(";");
  });

  it("posix does not treat backslashes as separators", () => {
    const shim = createPathShim();
    // pathe got this wrong — it normalized `a\b` to `a/b`.
    expect(shim.posix.basename("a\\b")).toBe("a\\b");
    expect(shim.posix.dirname("a\\b")).toBe(".");
    expect(shim.posix.normalize("a\\b")).toBe("a\\b");
  });

  it("win32 treats both slash kinds as separators", () => {
    const shim = createPathShim();
    expect(shim.win32.basename("aaa\\bbb")).toBe("bbb");
    expect(shim.win32.basename("aaa/bbb")).toBe("bbb");
    expect(shim.win32.normalize("//")).toBe("\\");
    expect(shim.win32.isAbsolute("/")).toBe(true);
    expect(shim.win32.isAbsolute("C:\\foo")).toBe(true);
    expect(shim.win32.isAbsolute("foo")).toBe(false);
  });

  it("posix edge cases match Node", () => {
    const shim = createPathShim();
    expect(shim.posix.normalize("//")).toBe("/");
    expect(shim.posix.normalize("///")).toBe("/");
    expect(shim.posix.normalize("a//b")).toBe("a/b");
    expect(shim.posix.basename("//a")).toBe("a");
    expect(shim.basename("aaa/bbb", "bbb")).toBe("bbb");
    expect(shim.basename("aaa/bbb", "bb")).toBe("b");
    expect(shim.basename("aaa/bbb", "b")).toBe("bb");
    expect(shim.join("a", "b")).toBe("a/b");
    expect(shim.dirname("/a/b")).toBe("/a");
    expect(shim.extname("file.tar.gz")).toBe(".gz");
    expect(shim.parse("/a/b/c.txt")).toEqual({
      root: "/",
      dir: "/a/b",
      base: "c.txt",
      ext: ".txt",
      name: "c",
    });
    expect(shim.format({ dir: "/a/b", base: "c.txt" })).toBe("/a/b/c.txt");
    expect(shim.relative("/a/b/c", "/a/d")).toBe("../../d");
  });

  it("win32 join/resolve produce backslash paths", () => {
    const shim = createPathShim();
    expect(shim.win32.join("a", "b")).toBe("a\\b");
    expect(shim.win32.basename("aaa\\bbb", "bbb")).toBe("bbb");
    expect(shim.win32.extname("file.txt")).toBe(".txt");
  });
});
