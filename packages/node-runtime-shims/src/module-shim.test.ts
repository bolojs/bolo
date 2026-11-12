import { describe, it, expect } from "vitest";
import { VfsBus } from "@bolojs/fs";
import { createModuleShim } from "./module-shim.js";

describe("createModuleShim", () => {
  it("resolves node builtins via the supplied getShim", () => {
    const vfs = new VfsBus();
    const pathShim = { sep: "/" };
    const moduleShim = createModuleShim({
      vfs,
      getShim: (name) => (name === "path" ? pathShim : undefined),
    });

    const require = moduleShim.createRequire("/entry.ts");
    expect(require("node:path")).toBe(pathShim);
    expect(require("path")).toBe(pathShim);
  });

  it("resolves subpath builtins via the parent shim's variant property", () => {
    const vfs = new VfsBus();
    const promises = { readFile: () => {} };
    const fsShim = { promises };
    const pathShim = { posix: { sep: "/" }, win32: { sep: "\\" } };
    const utilShim = { types: { isDate: () => true } };
    const moduleShim = createModuleShim({
      vfs,
      getShim: (name) =>
        (({ fs: fsShim, path: pathShim, util: utilShim }) as Record<string, unknown>)[name],
    });
    const require = moduleShim.createRequire("/entry.ts");

    expect(require("node:fs/promises")).toBe(promises);
    expect(require("node:path/win32")).toBe(pathShim.win32);
    expect(require("node:util/types")).toBe(utilShim.types);
  });

  it("resolves dns/promises to the dns shim itself (its API is already promisified)", () => {
    const vfs = new VfsBus();
    const dnsShim = { resolve4: () => Promise.resolve([]) };
    const moduleShim = createModuleShim({
      vfs,
      getShim: (name) => (name === "dns" ? dnsShim : undefined),
    });
    const require = moduleShim.createRequire("/entry.ts");

    expect(require("node:dns/promises")).toBe(dnsShim);
  });

  it("prefers a dedicated registry key over the parent-property walk", () => {
    const vfs = new VfsBus();
    const dedicated = { scheduler: true };
    const timersShim = { setTimeout: () => {} };
    const moduleShim = createModuleShim({
      vfs,
      getShim: (name) =>
        (({ timers: timersShim, "timers/promises": dedicated }) as Record<string, unknown>)[name],
    });
    const require = moduleShim.createRequire("/entry.ts");

    expect(require("node:timers/promises")).toBe(dedicated);
  });

  it("throws a clear error for a builtin with no registered shim", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const require = moduleShim.createRequire("/entry.ts");

    expect(() => require("node:worker_threads")).toThrow(
      /no browser shim registered for node builtin "worker_threads"/,
    );
  });

  it("throws a clear extension-point message for an unregistered pluggable builtin", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const require = moduleShim.createRequire("/entry.ts");

    expect(() => require("node:dgram")).toThrow(/Register a custom backend/);
    expect(moduleShim.isBuiltin("dgram")).toBe(true);
  });

  it("routes a pluggable builtin through getShim when one is registered", () => {
    const vfs = new VfsBus();
    const dgramShim = { createSocket: () => {} };
    const moduleShim = createModuleShim({
      vfs,
      getShim: (name) => (name === "dgram" ? dgramShim : undefined),
    });
    const require = moduleShim.createRequire("/entry.ts");

    expect(require("node:dgram")).toBe(dgramShim);
  });

  it("loads .node files via nativeAddonLoader when provided", () => {
    const vfs = new VfsBus();
    const addon = { native: true };
    const moduleShim = createModuleShim({
      vfs,
      getShim: () => undefined,
      nativeAddonLoader: (path) => ({ path, addon }),
    });
    const require = moduleShim.createRequire("/entry.ts");

    expect(require("./native.node")).toEqual({ path: "/native.node", addon });
  });

  it("throws when a .node import has no nativeAddonLoader", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const require = moduleShim.createRequire("/entry.ts");

    expect(() => require("./native.node")).toThrow(/Pass nativeAddonLoader/);
  });

  it("reads JSON files synchronously off the vfs, resolved relative to the requiring file", () => {
    const vfs = new VfsBus();
    (vfs.hot as unknown as { mkdirSync: (p: string, o?: unknown) => void }).mkdirSync("/pkg", {
      recursive: true,
    });
    (vfs.hot as unknown as { writeFileSync: (p: string, c: string) => void }).writeFileSync(
      "/pkg/data.json",
      '{"ok":true}',
    );
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const require = moduleShim.createRequire("/pkg/entry.ts");

    expect(require("./data.json")).toEqual({ ok: true });
  });

  it("throws a clear error for a dynamic require of an npm package", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const require = moduleShim.createRequire("/entry.ts");

    expect(() => require("lodash")).toThrow(/dynamic require\(\) of npm packages is not available/);
  });

  it("isBuiltin recognizes both prefixed and bare builtin names", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });

    expect(moduleShim.isBuiltin("node:fs")).toBe(true);
    expect(moduleShim.isBuiltin("fs")).toBe(true);
    expect(moduleShim.isBuiltin("lodash")).toBe(false);
  });

  it("exposes the Module constructor and statics (vite's named `Module` import)", () => {
    const vfs = new VfsBus();
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });
    const { Module } = moduleShim;

    const m = new Module("/app/entry.js");
    expect(m.id).toBe("/app/entry.js");
    expect(m.exports).toEqual({});

    expect(Module.builtinModules).toContain("fs");
    expect(Module.builtinModules).toContain("v8");
    expect(Module.builtinModules).toContain("http2");
    expect(typeof Module.createRequire).toBe("function");
    expect(Module._nodeModulePaths("/a/b/c")).toEqual([
      "/a/b/c/node_modules",
      "/a/b/node_modules",
      "/a/node_modules",
      "/node_modules",
    ]);
    // no-op-friendly statics
    expect(() => Module.syncBuiltinESMExports()).not.toThrow();
    expect(() => Module.register("./hooks.mjs")).not.toThrow();
    expect(Module.wrap("x()")).toBe(
      "(function (exports, require, module, __filename, __dirname) {x()\n})",
    );
  });

  it("findPackageJSON walks up from a resolved relative specifier", () => {
    const vfs = new VfsBus();
    const hot = vfs.hot as unknown as {
      mkdirSync: (p: string, o?: unknown) => void;
      writeFileSync: (p: string, c: string) => void;
    };
    hot.mkdirSync("/pkg/sub", { recursive: true });
    hot.writeFileSync("/pkg/package.json", "{}");
    hot.writeFileSync("/pkg/sub/deep.js", "");
    const moduleShim = createModuleShim({ vfs, getShim: () => undefined });

    expect(moduleShim.findPackageJSON("./sub/deep.js", "/pkg/index.js")).toBe("/pkg/package.json");
    expect(moduleShim.findPackageJSON("/pkg/sub/deep.js")).toBe("/pkg/package.json");
    expect(moduleShim.findPackageJSON("lodash")).toBeUndefined();
    expect(moduleShim.findPackageJSON("./nope.js", "/other/index.js")).toBeUndefined();
  });
});
