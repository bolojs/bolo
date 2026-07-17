import { describe, it, expect, vi } from "vitest";
import { ReplService } from "./repl-service.js";

describe("ReplService", () => {
  it("starts the REPL worker and loads history", async () => {
    const vfs = {
      readFile: vi.fn(async () => "a\nb\n"),
    };
    const runtimeWorker = {
      startRepl: vi.fn(),
      evalRepl: vi.fn(async () => ({ ok: true, value: "2" })),
      disposeRepl: vi.fn(),
    };

    const repl = new ReplService({ vfs: vfs as never, runtimeWorker: runtimeWorker as never });
    await repl.start();

    expect(runtimeWorker.startRepl).toHaveBeenCalled();
    expect(vfs.readFile).toHaveBeenCalledWith("/home/web/.node_repl_history");
    expect(repl.getHistory()).toEqual(["a", "b"]);

    const result = await repl.eval("1 + 1");
    expect(runtimeWorker.evalRepl).toHaveBeenCalledWith("1 + 1");
    expect(result).toEqual({ ok: true, value: "2" });
  });

  it("disposes the REPL worker", () => {
    const runtimeWorker = {
      startRepl: vi.fn(),
      evalRepl: vi.fn(),
      disposeRepl: vi.fn(),
    };
    const repl = new ReplService({ vfs: {} as never, runtimeWorker: runtimeWorker as never });
    repl.dispose();
    expect(runtimeWorker.disposeRepl).toHaveBeenCalled();
  });
});
