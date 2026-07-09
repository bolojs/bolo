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

  it("should resolve the A2 builtins added to SHIMMED_BUILTINS", async () => {
    const plugin = nodeWebShims();
    const resolveId = getResolveId(plugin);
    for (const name of [
      "string_decoder",
      "tty",
      "assert",
      "zlib",
      "constants",
      "perf_hooks",
      "timers",
      "punycode",
      "diagnostics_channel",
      "readline",
    ]) {
      const result = await resolveId?.(`node:${name}`);
      expect(result, name).toMatch(new RegExp(`/dist/${name}\\.js$`));
    }
  });
});
