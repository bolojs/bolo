import { describe, it, expect } from "vitest";
import type { Plugin } from "vite";
import { nodeWebShims } from "../src/vite-plugin.ts";

function getResolveId(plugin: Plugin) {
  if (typeof plugin.resolveId === "function") {
    return plugin.resolveId.bind(plugin);
  }
  return plugin.resolveId?.handler.bind(plugin);
}

describe("node-web-shims: vite-plugin", () => {
  it("should be a function", () => {
    expect(typeof nodeWebShims).toBe("function");
  });

  it("should return a Vite plugin", () => {
    const plugin = nodeWebShims();
    expect(plugin.name).toBe("@browser-containers/node-web-shims");
  });

  it("should have resolveId hook", () => {
    const plugin = nodeWebShims();
    expect(plugin.resolveId).toBeDefined();
  });

  it("should resolve node: imports to dist path for shimmed builtins", async () => {
    const plugin = nodeWebShims();
    const resolveId = getResolveId(plugin);
    const result = await resolveId?.("node:crypto");
    expect(result).toBeDefined();
    expect(result).toMatch(/\/dist\/crypto\.js$/);
  });

  it("should return null for non-shimmed bare imports", async () => {
    const plugin = nodeWebShims();
    const resolveId = getResolveId(plugin);
    const result = await resolveId?.("fs");
    expect(result).toBeNull();
  });

  it("should resolve shimmed bare builtins to dist path", async () => {
    const plugin = nodeWebShims();
    const resolveId = getResolveId(plugin);
    const result = await resolveId?.("path");
    expect(result).toBeDefined();
    expect(result).toMatch(/\/dist\/path\.js$/);
  });
});
