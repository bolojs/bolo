import { describe, it, expect, vi } from "vitest";
import type { VfsBus } from "@bolojs/fs";
import { createProcessOps } from "./remote-ops.js";

const vfs = {} as VfsBus;

describe("createProcessOps thread.* ops", () => {
  it("spawns, relays send, and terminates a thread", async () => {
    const handle = { post: vi.fn(), terminate: vi.fn() };
    const spawn = vi.fn(async () => handle);
    const dispatch = createProcessOps({ vfs, threads: { spawn } });
    const onMessage = vi.fn();
    const onExit = vi.fn();

    const id = (await dispatch("thread.spawn", [
      { filename: "./w.js", workerData: 7 },
      onMessage,
      onExit,
    ])) as number;
    expect(typeof id).toBe("number");
    expect(spawn).toHaveBeenCalledWith(
      { filename: "./w.js", workerData: 7 },
      onMessage,
      expect.any(Function),
      undefined,
      undefined,
    );

    await dispatch("thread.send", [id, "hello"]);
    expect(handle.post).toHaveBeenCalledWith("hello");

    await dispatch("thread.terminate", [id]);
    expect(handle.terminate).toHaveBeenCalled();
  });

  it("thread.send to an unknown id is a no-op", async () => {
    const dispatch = createProcessOps({
      vfs,
      threads: { spawn: async () => ({ post: () => {}, terminate: () => {} }) },
    });
    await expect(dispatch("thread.send", [999, "x"])).resolves.toBe(0);
  });

  it("spawn errors propagate to the caller", async () => {
    const dispatch = createProcessOps({
      vfs,
      threads: {
        spawn: async () => {
          throw new Error("no worker available");
        },
      },
    });
    await expect(dispatch("thread.spawn", [{}, () => {}, () => {}])).rejects.toThrow(
      "no worker available",
    );
  });

  it("rejects unknown ops without a threads dep", async () => {
    const dispatch = createProcessOps({ vfs });
    await expect(dispatch("thread.spawn", [{}, () => {}, () => {}])).rejects.toThrow(
      /unknown op/,
    );
  });
});
