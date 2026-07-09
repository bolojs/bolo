import { describe, it, expect, beforeEach, vi } from "vitest";
import { VfsBus } from "./vfs-bus.js";

describe("VfsBus events", () => {
  let vfs: VfsBus;

  beforeEach(() => {
    vfs = new VfsBus();
  });

  it('on("write") fires after writeFile', async () => {
    const handler = vi.fn();
    vfs.on("write", handler);
    await vfs.writeFile("/test.txt", "data");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: "write", path: "/test.txt" });
  });

  it('on("delete") fires after rm', async () => {
    await vfs.writeFile("/to-delete.txt", "x");
    const handler = vi.fn();
    vfs.on("delete", handler);
    await vfs.rm("/to-delete.txt");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: "delete", path: "/to-delete.txt" });
  });

  it('on("write") fires after mkdir', async () => {
    const handler = vi.fn();
    vfs.on("write", handler);
    await vfs.mkdir("/newdir");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: "write", path: "/newdir" });
  });

  it('on("delete") does not fire for writeFile', async () => {
    const handler = vi.fn();
    vfs.on("delete", handler);
    await vfs.writeFile("/test.txt", "data");
    expect(handler).not.toHaveBeenCalled();
  });

  it('on("write") does not fire for rm', async () => {
    await vfs.writeFile("/to-delete.txt", "x");
    const handler = vi.fn();
    vfs.on("write", handler);
    await vfs.rm("/to-delete.txt");
    expect(handler).not.toHaveBeenCalled();
  });
});
