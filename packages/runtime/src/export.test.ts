import { describe, expect, it } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createExport } from "./export.js";
import { createMount } from "./mount.js";

describe("createExport", () => {
  it("should export empty filesystem as empty tree", async () => {
    const vfs = new VfsBus();
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(Object.keys(tree).length).toBe(0);
  });

  it("should export a single file", async () => {
    const vfs = new VfsBus();
    await vfs.writeFile("/a.txt", "hello");
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["a.txt"]).toEqual({ file: { contents: "hello" } });
  });

  it("should export a single directory", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/mydir", { recursive: true });
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["mydir"]).toEqual({ directory: {} });
  });

  it("should export nested files", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/src", { recursive: true });
    await vfs.writeFile("/src/app.js", "app");
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["src"]).toEqual({ directory: { "app.js": { file: { contents: "app" } } } });
  });

  it("should export deeply nested structure", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/a/b/c", { recursive: true });
    await vfs.writeFile("/a/b/c/deep.txt", "deep");
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["a"]).toEqual({
      directory: {
        b: {
          directory: {
            c: {
              directory: {
                "deep.txt": { file: { contents: "deep" } },
              },
            },
          },
        },
      },
    });
  });

  it("should export mixed files and directories", async () => {
    const vfs = new VfsBus();
    await vfs.writeFile("/index.js", "index");
    await vfs.mkdir("/src/lib", { recursive: true });
    await vfs.writeFile("/src/app.js", "app");
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["index.js"]).toEqual({ file: { contents: "index" } });
    expect(tree["src"]).toEqual({
      directory: {
        "app.js": { file: { contents: "app" } },
        lib: { directory: {} },
      },
    });
  });

  it("should round-trip mount then export", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    const { exportTree } = createExport(vfs);
    const original = {
      "a.txt": { file: { contents: "hello" } },
      dir: {
        directory: {
          "b.txt": { file: { contents: "world" } },
        },
      },
    };
    await mountTree(original);
    const exported = await exportTree();
    expect(exported).toEqual(original);
  });

  it("should export binary content", async () => {
    const vfs = new VfsBus();
    await vfs.writeFile("/bin.dat", "binary");
    const { exportTree } = createExport(vfs);
    const tree = await exportTree();
    expect(tree["bin.dat"]).toEqual({ file: { contents: "binary" } });
  });
});
