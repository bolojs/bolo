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
});
