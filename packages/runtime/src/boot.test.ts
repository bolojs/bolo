import { describe, it, expect, vi, beforeEach } from "vitest";
import { boot } from "./boot.js";
import { BrowserContainer } from "./container.js";
import { SWSandbox } from "@bolojs/sw-sandbox";

vi.mock("@bolojs/sw-sandbox", () => ({
  SWSandbox: {
    create: vi.fn().mockResolvedValue({
      onFetch: vi.fn(),
      setPolicyRegistry: vi.fn(),
    }),
  },
}));

describe("boot()", () => {
  let container: BrowserContainer;

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("returns a BrowserContainer instance", async () => {
    container = await boot({ dangerouslyAllowSameOrigin: true });
    expect(container).toBeInstanceOf(BrowserContainer);
    expect(container.fs).toBeDefined();
    expect(container.workdir).toBe("/home/web");
    await container.teardown();
  });

  it("sets workdir from options", async () => {
    container = await boot({ workdirName: "/home/project", dangerouslyAllowSameOrigin: true });
    expect(container.workdir).toBe("/home/project");
    await container.teardown();
  });

  it("rejects second boot() while active", async () => {
    container = await boot({ dangerouslyAllowSameOrigin: true });
    await expect(boot({ dangerouslyAllowSameOrigin: true })).rejects.toThrow("already running");
    await container.teardown();
  });

  it("allows re-boot after teardown", async () => {
    const c1 = await boot({ dangerouslyAllowSameOrigin: true });
    await c1.teardown();
    const c2 = await boot({ dangerouslyAllowSameOrigin: true });
    expect(c2).toBeInstanceOf(BrowserContainer);
    await c2.teardown();
  });

  it("wires BrowserViteServer + sandbox.onFetch at boot for /__preview/", async () => {
    // 2ac6bb9b moved vite wiring out of `npm run dev` and into boot(); this
    // pins the new contract so the move can't silently regress.
    const container = await boot({ dangerouslyAllowSameOrigin: true });
    const sandbox = await vi.mocked(SWSandbox.create).mock.results[0].value;
    expect(sandbox.onFetch).toHaveBeenCalledWith(expect.any(Function));
    await container.teardown();
  });

  it("mount and export round-trip", async () => {
    container = await boot({ dangerouslyAllowSameOrigin: true });
    const tree = {
      "index.js": { file: { contents: "console.log(1)" } },
      src: { directory: { "app.js": { file: { contents: "export const app = 1" } } } },
    };
    await container.mount(tree);
    const exported = await container.export();
    expect(exported["index.js"]).toEqual(tree["index.js"]);
    expect(exported["src"]).toEqual(tree["src"]);
    await container.teardown();
  });
});
