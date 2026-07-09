import { describe, expect, it } from "vitest";
import { VfsBus } from "@browser-containers/vfs-bus";
import { createMount } from "./mount.js";

describe("createMount", () => {
  it("should mount a single file", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({ "test.txt": { file: { contents: "hello" } } });
    expect(await vfs.readFile("/test.txt")).toBe("hello");
  });

  it("should mount a single directory", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({ dir: { directory: {} } });
    expect(await vfs.exists("/dir")).toBe(true);
  });

  it("should mount nested files", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({
      src: {
        directory: {
          "app.js": { file: { contents: "app" } },
        },
      },
    });
    expect(await vfs.readFile("/src/app.js")).toBe("app");
  });

  it("should mount deeply nested structure", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({
      a: {
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
      },
    });
    expect(await vfs.readFile("/a/b/c/deep.txt")).toBe("deep");
  });

  it("should mount Uint8Array contents", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    const data = new TextEncoder().encode("binary");
    await mountTree({ "bin.dat": { file: { contents: data } } });
    const result = await vfs.readFile("/bin.dat");
    expect(result).toBe("binary");
  });

  it("should mount empty tree without error", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({});
    expect((await vfs.readdir("/")).length).toBe(0);
  });

  it("should mount mixed files and directories", async () => {
    const vfs = new VfsBus();
    const { mountTree } = createMount(vfs);
    await mountTree({
      "index.js": { file: { contents: "index" } },
      src: {
        directory: {
          "app.js": { file: { contents: "app" } },
          lib: {
            directory: {},
          },
        },
      },
    });
    expect(await vfs.readFile("/index.js")).toBe("index");
    expect(await vfs.readFile("/src/app.js")).toBe("app");
    expect(await vfs.exists("/src/lib")).toBe(true);
  });
});
