import { describe, it, expect } from "vitest";
import { nodeRuntimeShims } from "./vite-plugin.js";

describe("nodeRuntimeShims", () => {
  it("resolves node:https to the shim id", () => {
    const plugin = nodeRuntimeShims({ vfs: {}, sandbox: {} });
    const resolve = plugin.resolveId as (id: string) => string | null;
    expect(resolve("node:https")).toBe("node:https");
  });

  it("loads node:https using the same http shim code", () => {
    const plugin = nodeRuntimeShims({ vfs: {}, sandbox: {} });
    const load = plugin.load as (id: string) => string | null;
    const loaded = load("node:https");
    expect(loaded).toContain("createHttpShim");
    expect(loaded).toContain("ServerResponse");
  });
});
