import { describe, expect, it } from "vitest";
import { VfsBus } from "@bolojs/vfs-bus";
import { createWatchAdapter } from "./watch-adapter.js";

describe("createWatchAdapter", () => {
  it("should detect new file creation as rename event", async () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const events: Array<{ event: string; filename: string }> = [];
    const watcher = watch("/dir", {}, (event, filename) => {
      events.push({ event, filename });
    });
    await vfs.mkdir("/dir", { recursive: true });
    await vfs.writeFile("/dir/newfile.txt", "content");
    watcher.close();
    expect(events.some((e) => e.event === "rename" && e.filename === "newfile.txt")).toBe(true);
  });

  it("should detect file deletion as rename event", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/dir", { recursive: true });
    await vfs.writeFile("/dir/oldfile.txt", "content");
    const watch = createWatchAdapter(vfs);
    const events: Array<{ event: string; filename: string }> = [];
    const watcher = watch("/dir", {}, (event, filename) => {
      events.push({ event, filename });
    });
    await vfs.rm("/dir/oldfile.txt");
    watcher.close();
    expect(events.some((e) => e.event === "rename" && e.filename === "oldfile.txt")).toBe(true);
  });

  it("should stop receiving events after close", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/dir", { recursive: true });
    const watch = createWatchAdapter(vfs);
    const events: Array<{ event: string; filename: string }> = [];
    const watcher = watch("/dir", {}, (event, filename) => {
      events.push({ event, filename });
    });
    watcher.close();
    await vfs.writeFile("/dir/after-close.txt", "content");
    expect(events.length).toBe(0);
  });

  it("should use exact path glob for file watch", async () => {
    const vfs = new VfsBus();
    await vfs.mkdir("/dir", { recursive: true });
    const watch = createWatchAdapter(vfs);
    const events: Array<{ event: string; filename: string }> = [];
    const watcher = watch("/dir/specific.txt", {}, (event, filename) => {
      events.push({ event, filename });
    });
    await vfs.writeFile("/dir/specific.txt", "content");
    watcher.close();
    expect(events.some((e) => e.filename === "specific.txt")).toBe(true);
  });

  it("should return Watcher with close method", () => {
    const vfs = new VfsBus();
    const watch = createWatchAdapter(vfs);
    const watcher = watch("/dir");
    expect(typeof watcher.close).toBe("function");
    watcher.close();
  });
});
