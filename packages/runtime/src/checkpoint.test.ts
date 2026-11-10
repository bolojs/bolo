import { describe, it, expect, vi } from "vitest";
import { boot } from "./boot.js";
import { CHECKPOINT_FORMAT, type ContainerCheckpoint } from "./checkpoint.js";
import type { SandboxBackend, SandboxSnapshot } from "./sandbox-backend.js";

vi.mock("@bolojs/sandbox", () => ({
  SWSandbox: {
    create: vi.fn().mockResolvedValue({
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    }),
  },
}));

const SNAPSHOT: SandboxSnapshot = { bytes: new Uint8Array([1, 2, 3]), format: "stub@1" };

const createSnapshotBackend = () => ({
  run: vi.fn().mockResolvedValue({ result: "ok" }),
  dispose: vi.fn(),
  snapshot: vi.fn().mockResolvedValue(SNAPSHOT),
  restore: vi.fn().mockResolvedValue(undefined),
});

const createPlainBackend = (): SandboxBackend => ({
  run: vi.fn().mockResolvedValue({ result: "ok" }),
  dispose: vi.fn(),
});

describe("container checkpoint / resume", () => {
  it("checkpoint() captures vfs, workdir, format and sandbox state", async () => {
    const backend = createSnapshotBackend();
    const container = await boot({ sandbox: backend });
    await container.fs.writeFile("/home/web/notes.txt", "hello");

    const cp = await container.checkpoint();

    expect(cp.format).toBe(CHECKPOINT_FORMAT);
    expect(cp.workdir).toBe("/home/web");
    expect(cp.vfs["/home/web/notes.txt"]).toBe("hello");
    expect(cp.sandbox).toEqual(SNAPSHOT);
    expect(backend.snapshot).toHaveBeenCalledOnce();
    await container.teardown();
  });

  it("checkpoint() omits sandbox state when the backend does not support it", async () => {
    const container = await boot({ dangerouslyAllowSameOrigin: true });
    const cp = await container.checkpoint();
    expect(cp.sandbox).toBeUndefined();
    await container.teardown();
  });

  it("boot({ resume }) restores vfs contents and backend state", async () => {
    const first = await boot({ sandbox: createSnapshotBackend() });
    await first.fs.writeFile("/home/web/a.txt", "persisted");
    const cp = await first.checkpoint();
    await first.teardown();

    const backend2 = createSnapshotBackend();
    const second = await boot({ sandbox: backend2, resume: cp });
    expect(await second.fs.readFile("/home/web/a.txt")).toBe("persisted");
    expect(backend2.restore).toHaveBeenCalledWith(SNAPSHOT);
    await second.teardown();
  });

  it("adopts the checkpoint workdir when workdirName is not set", async () => {
    const first = await boot({ workdirName: "/home/proj", dangerouslyAllowSameOrigin: true });
    await first.fs.writeFile("/home/proj/f.txt", "x");
    const cp = await first.checkpoint();
    await first.teardown();

    const second = await boot({ dangerouslyAllowSameOrigin: true, resume: cp });
    expect(second.workdir).toBe("/home/proj");
    expect(await second.fs.readFile("/home/proj/f.txt")).toBe("x");
    await second.teardown();
  });

  it("rejects resume when workdirName mismatches the checkpoint", async () => {
    const cp: ContainerCheckpoint = {
      vfs: {},
      format: CHECKPOINT_FORMAT,
      workdir: "/home/web",
      createdAt: new Date().toISOString(),
    };
    await expect(
      boot({ workdirName: "/other", dangerouslyAllowSameOrigin: true, resume: cp }),
    ).rejects.toThrow("does not match checkpoint workdir");
  });

  it("rejects a checkpoint with an unknown format", async () => {
    const cp = {
      vfs: {},
      format: "bolo-checkpoint@99",
      workdir: "/home/web",
      createdAt: new Date().toISOString(),
    } as unknown as ContainerCheckpoint;
    await expect(boot({ dangerouslyAllowSameOrigin: true, resume: cp })).rejects.toThrow(
      "Unsupported checkpoint format",
    );
  });

  it("rejects resume when the backend cannot restore checkpoint sandbox state", async () => {
    const cp: ContainerCheckpoint = {
      vfs: {},
      sandbox: SNAPSHOT,
      format: CHECKPOINT_FORMAT,
      workdir: "/home/web",
      createdAt: new Date().toISOString(),
    };
    await expect(boot({ dangerouslyAllowSameOrigin: true, resume: cp })).rejects.toThrow(
      "cannot restore",
    );
    await expect(boot({ sandbox: createPlainBackend(), resume: cp })).rejects.toThrow(
      "cannot restore",
    );
  });

  it("resumes a vfs-only checkpoint without a configured backend", async () => {
    const cp: ContainerCheckpoint = {
      vfs: { "/home/web/only.txt": "vfs-only" },
      format: CHECKPOINT_FORMAT,
      workdir: "/home/web",
      createdAt: new Date().toISOString(),
    };
    const container = await boot({ dangerouslyAllowSameOrigin: true, resume: cp });
    expect(await container.fs.readFile("/home/web/only.txt")).toBe("vfs-only");
    await container.teardown();
  });

  it("checkpoint() after teardown rejects", async () => {
    const container = await boot({ dangerouslyAllowSameOrigin: true });
    await container.teardown();
    await expect(container.checkpoint()).rejects.toThrow("torn down");
  });
});
