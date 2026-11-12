import { describe, it, expect } from "vitest";
import { shimModuleSource, NODE_BUILTIN_NAMES } from "./bundle";

describe("shimModuleSource", () => {
  it("exports the shim as default, module.exports and named keys", () => {
    const src = shimModuleSource("assert", ["strictEqual"]);
    expect(src).toContain("export default __shim;");
    expect(src).toContain('export { __shim as "module.exports" };');
    expect(src).toContain('export const strictEqual = __shim["strictEqual"];');
  });
});

describe("NODE_BUILTIN_NAMES", () => {
  it("routes every builtin with a shipped shim — registry key, subpath variant, or banner console", () => {
    for (const name of [
      "vm",
      "dns",
      "dns/promises",
      "fs/promises",
      "assert/strict",
      "stream/promises",
      "util/types",
      "path/posix",
      "path/win32",
      "readline/promises",
      "console",
      "v8",
      "module",
      "timers/promises",
      "stream/web",
      "stream/consumers",
    ]) {
      expect(NODE_BUILTIN_NAMES.has(name), `node:${name}`).toBe(true);
    }
  });
});
