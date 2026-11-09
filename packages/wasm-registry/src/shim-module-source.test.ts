import { describe, it, expect } from "vitest";
import { shimModuleSource } from "./bundle";

describe("shimModuleSource", () => {
  it("exports the shim as default, module.exports and named keys", () => {
    const src = shimModuleSource("assert", ["strictEqual"]);
    expect(src).toContain("export default __shim;");
    expect(src).toContain('export { __shim as "module.exports" };');
    expect(src).toContain('export const strictEqual = __shim["strictEqual"];');
  });
});
