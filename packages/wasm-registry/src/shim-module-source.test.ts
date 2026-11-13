import { describe, it, expect } from "vitest";
import { shimModuleSource, NODE_BUILTIN_NAMES } from "./bundle";

describe("shimModuleSource", () => {
  it("exports the shim as default, module.exports and named keys", () => {
    const src = shimModuleSource("assert", ["strictEqual"]);
    expect(src).toContain("export default __shim;");
    expect(src).toContain('export { __shim as "module.exports" };');
    expect(src).toContain('export const strictEqual = __shim["strictEqual"];');
  });

  it("wraps a class-valued shim itself for call-compatible subclassing", () => {
    // events: the shim object IS the EventEmitter class; `EventEmitter.call(this)`
    // must keep working for util.inherits-style legacy packages (winston).
    const src = shimModuleSource("events", ["EventEmitter", "once"], undefined, {
      selfIsClass: true,
      selfKeys: new Set(["EventEmitter"]),
    });
    expect(src).toContain("const __self = __bc_callCompat(__shim);");
    expect(src).toContain("export default __self;");
    expect(src).toContain('export { __self as "module.exports" };');
    expect(src).toContain("export const EventEmitter = __self;");
    expect(src).toContain('export const once = __shim["once"];');
  });

  it("wraps class-valued exports in place so module identity survives", () => {
    // worker_threads/async_hooks shape: plain-object shim whose props are
    // classes — require('x').Klass.call(this) reads the prop off module.exports.
    // The wrap mutates the live shim (callCompat is WeakMap-cached) rather than
    // copying it: Node requires require('fs/promises') === fs.promises and
    // require('x') === process.getBuiltinModule('x').
    const src = shimModuleSource("worker_threads", ["Worker", "isMainThread"], undefined, {
      classKeys: new Set(["Worker"]),
    });
    expect(src).toContain("Object.defineProperty(__shim, __k,");
    expect(src).toContain("__bc_callCompat(__d.value)");
    expect(src).not.toContain("__moduleExports");
    expect(src).toContain("export default __shim;");
    expect(src).toContain('export { __shim as "module.exports" };');
    expect(src).toContain('export const Worker = __bc_callCompat(__shim["Worker"]);');
    expect(src).toContain('export const isMainThread = __shim["isMainThread"];');
  });

  it("does not copy the module object for callable shims", () => {
    const src = shimModuleSource("assert", ["strictEqual"], undefined, {
      moduleIsFunction: true,
    });
    expect(src).not.toContain("__moduleExports");
    expect(src).toContain("export default __shim;");
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
