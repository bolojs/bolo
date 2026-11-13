import { describe, it, expect, vi } from "vitest";
import { VfsBus } from "@bolojs/fs";
import {
  NATIVE_ADDON_WASM_VARIANTS,
  createWasmNativeAddonLoader,
  warmWasmAddons,
  wasmAddonSpecifiers,
} from "./native-addon-resolver.js";

const writeJson = (vfs: VfsBus, path: string, contents: string): void => {
  const hot = vfs.hot as unknown as {
    mkdirSync: (p: string, o?: unknown) => void;
    writeFileSync: (p: string, c: string) => void;
  };
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir !== "/") hot.mkdirSync(dir, { recursive: true });
  hot.writeFileSync(path, contents);
};

const vfsWithPackage = (pkgDir: string, pkgJson: Record<string, unknown>): VfsBus => {
  const vfs = new VfsBus();
  writeJson(vfs, `${pkgDir}/package.json`, JSON.stringify(pkgJson));
  return vfs;
};

describe("NATIVE_ADDON_WASM_VARIANTS", () => {
  it("maps the curated native packages to their WASM/JS variants", () => {
    expect(NATIVE_ADDON_WASM_VARIANTS.argon2).toBe("argon2-wasm@0.9.0");
    expect(NATIVE_ADDON_WASM_VARIANTS.lightningcss).toBe("lightningcss-wasm@1.33.0");
    expect(NATIVE_ADDON_WASM_VARIANTS.bcrypt).toBe("bcryptjs@3.0.2");
  });
});

describe("createWasmNativeAddonLoader", () => {
  it("resolves a .node require inside argon2 to the warmed argon2-wasm exports", () => {
    const vfs = vfsWithPackage("/app/node_modules/argon2", { name: "argon2" });
    const exports = { hash: async () => "x" };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "argon2-wasm@0.9.0": exports },
    });

    expect(loader("/app/node_modules/argon2/prebuilds/release/bcrypt.node", vfs)).toBe(exports);
  });

  it("resolves bcrypt's .node require to bcryptjs", () => {
    const vfs = vfsWithPackage("/app/node_modules/bcrypt", { name: "bcrypt" });
    const exports = { hashSync: () => "h" };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "bcryptjs@3.0.2": exports },
    });

    expect(loader("/app/node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node", vfs)).toBe(
      exports,
    );
  });

  it("walks up to the nearest package.json, not necessarily the .node's dir", () => {
    const vfs = vfsWithPackage("/app/node_modules/lightningcss", { name: "lightningcss" });
    const exports = { transform: () => ({}) };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "lightningcss-wasm@1.33.0": exports },
    });

    expect(
      loader("/app/node_modules/lightningcss/node_modules/@parcel/watcher-linux-x64/watcher.node", vfs),
    ).toBe(exports);
  });

  it("honours package.json variants overrides", () => {
    const vfs = vfsWithPackage("/app/node_modules/argon2", { name: "argon2" });
    const exports = { custom: true };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "my-argon2@1.0.0": exports },
      variants: { argon2: "my-argon2@1.0.0" },
    });

    expect(loader("/app/node_modules/argon2/x.node", vfs)).toBe(exports);
  });

  it("falls back to a string browser field as the variant specifier", () => {
    const vfs = vfsWithPackage("/app/node_modules/fancy-hash", {
      name: "fancy-hash",
      browser: "fancy-hash-wasm@2.0.0",
    });
    const exports = { verify: () => true };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "fancy-hash-wasm@2.0.0": exports },
    });

    expect(loader("/app/node_modules/fancy-hash/build/Release/hash.node", vfs)).toBe(exports);
  });

  it("falls back to an object browser-field remap for the .node path", () => {
    const vfs = vfsWithPackage("/app/node_modules/fancy-hash", {
      name: "fancy-hash",
      browser: { "./lib/binding.node": "fancy-hash-wasm@2.0.0" },
    });
    const exports = { verify: () => true };
    const loader = createWasmNativeAddonLoader({
      vfs,
      addons: { "fancy-hash-wasm@2.0.0": exports },
    });

    expect(loader("/app/node_modules/fancy-hash/lib/binding.node", vfs)).toBe(exports);
  });

  it("returns an empty module for a browser-field false stub", () => {
    const vfs = vfsWithPackage("/app/node_modules/stubbed", {
      name: "stubbed",
      browser: { "./native.node": false },
    });
    const loader = createWasmNativeAddonLoader({ vfs, addons: {} });

    expect(loader("/app/node_modules/stubbed/native.node", vfs)).toEqual({});
  });

  it("throws a catalogued error naming the variant when the addon is cold", () => {
    const vfs = vfsWithPackage("/app/node_modules/argon2", { name: "argon2" });
    const loader = createWasmNativeAddonLoader({ vfs, addons: {} });

    try {
      loader("/app/node_modules/argon2/x.node", vfs);
      expect.unreachable();
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e.code).toBe("ERR_BOL_UNSUPPORTED_NATIVE_ADDON_COLD");
      expect(e.message).toContain("argon2-wasm@0.9.0");
      expect(e.message).toContain("warmWasmAddons");
    }
  });

  it("throws a catalogued error for packages with no variant and no browser field", () => {
    const vfs = vfsWithPackage("/app/node_modules/mystery", { name: "mystery" });
    const loader = createWasmNativeAddonLoader({ vfs, addons: {} });

    try {
      loader("/app/node_modules/mystery/x.node", vfs);
      expect.unreachable();
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e.code).toBe("ERR_BOL_UNSUPPORTED_NATIVE_ADDON");
      expect(e.message).toContain("mystery");
    }
  });

  it("throws when no package.json owns the .node path", () => {
    const vfs = new VfsBus();
    const loader = createWasmNativeAddonLoader({ vfs, addons: {} });

    expect(() => loader("/lonely/x.node", vfs)).toThrow(/native \.node addon/);
  });
});

describe("warmWasmAddons", () => {
  it("imports each specifier and returns a specifier→exports map", async () => {
    const importModule = vi.fn(async (spec: string) => ({ loaded: spec }));
    const out = await warmWasmAddons(["a@1", "b@2"], importModule);
    expect(out).toEqual({ "a@1": { loaded: "a@1" }, "b@2": { loaded: "b@2" } });
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("caches warmed modules per specifier across calls", async () => {
    const importModule = vi.fn(async (spec: string) => ({ loaded: spec }));
    await warmWasmAddons(["cached@1"], importModule);
    await warmWasmAddons(["cached@1"], importModule);
    expect(importModule).toHaveBeenCalledTimes(1);
  });
});

describe("wasmAddonSpecifiers", () => {
  it("returns every curated variant specifier", () => {
    expect(wasmAddonSpecifiers().sort()).toEqual(
      Object.values(NATIVE_ADDON_WASM_VARIANTS).sort(),
    );
  });
});
