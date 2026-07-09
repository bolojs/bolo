import { describe, it, expect, beforeEach, vi } from "vitest";
import { VfsBus } from "./vfs-bus.js";

describe("VfsBus watch", () => {
  let vfs: VfsBus;

  beforeEach(() => {
    vfs = new VfsBus();
  });

  it('watch("**") receives add event on writeFile', async () => {
    const handler = vi.fn();
    vfs.watch("**", handler);
    await vfs.writeFile("/src/app.ts", "hello");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("/src/app.ts", "add");
  });

  it('watch("**") receives unlink event on rm', async () => {
    await vfs.writeFile("/remove-me.txt", "x");
    const handler = vi.fn();
    vfs.watch("**", handler);
    await vfs.rm("/remove-me.txt");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("/remove-me.txt", "unlink");
  });

  it("watch with suffix glob matches", async () => {
    const handler = vi.fn();
    vfs.watch("/src/*", handler);
    await vfs.writeFile("/src/a.ts", "a");
    await vfs.mkdir("/other", { recursive: true });
    await vfs.writeFile("/other/b.ts", "b");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("/src/a.ts", "add");
  });

  it("watch close stops notifications", async () => {
    const handler = vi.fn();
    const w = vfs.watch("**", handler);
    await vfs.writeFile("/first.txt", "1");
    w.close();
    await vfs.writeFile("/second.txt", "2");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
