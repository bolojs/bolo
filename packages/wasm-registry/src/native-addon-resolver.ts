import type { VfsBus } from "@bolojs/fs";
import { buildEsmShUrl } from "@bolojs/pm";

/**
 * Curated map from an npm package that ships a native `.node` binding to the
 * browser/WASM (or pure-JS) package that replaces it. Keys are the `name`
 * field of the package.json that owns the `.node` file being required —
 * i.e. the package the user installed, not the variant.
 *
 * Versions are pinned so the warmed module and any cached binary stay
 * reproducible; bump together with the compat matrix expectations.
 */
export const NATIVE_ADDON_WASM_VARIANTS: Record<string, string> = {
  // node-argon2's native binding → the official Argon2 WASM build.
  argon2: "argon2-wasm@0.9.0",
  // napi `.node` platform binding → the official WASM build (napi-wasm).
  lightningcss: "lightningcss-wasm@1.33.0",
  // node.bcrypt.js native binding → the API-compatible pure-JS package.
  bcrypt: "bcryptjs@3.0.2",
};

/**
 * Loader signature mirrors `NativeAddonLoader` in `@bolojs/node-runtime-shims`
 * (`live.ts`). Declared locally so `@bolojs/registry` does not take a
 * dependency on the shims package — structural typing makes the two
 * interchangeable at the `createLiveShimRegistry` call site.
 */
export type WasmNativeAddonLoader = (modulePath: string, vfs: VfsBus) => unknown;

export interface WasmNativeAddonLoaderOptions {
  readonly vfs: VfsBus;
  /**
   * Pre-warmed variant exports keyed by specifier — the same keys
   * `warmWasmAddons` returns (e.g. `"argon2-wasm@0.9.0"`). The map is read
   * lazily on every `.node` require, so callers may populate it after the
   * loader is created (a `require()` is synchronous and cannot await an
   * `import()`, so warming has to happen before the first native require).
   */
  readonly addons: Record<string, unknown>;
  /** Specifier overrides merged over {@link NATIVE_ADDON_WASM_VARIANTS}. */
  readonly variants?: Record<string, string>;
}

const dirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
};

const joinPath = (...parts: string[]): string => {
  const segments: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
};

const cataloguedAddonError = (code: string, message: string): Error => {
  const err = new Error(message);
  Object.defineProperty(err, "code", {
    value: `ERR_BOL_UNSUPPORTED_${code}`,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return err;
};

interface OwningPackage {
  /** Absolute VFS dir containing the package.json. */
  dir: string;
  name?: string;
  browser?: unknown;
}

/**
 * Nearest ancestor `package.json` of a `.node` module path — the same walk
 * `findOwningPackageDir`/`findPackageJSON` do in `bundle.ts`/`module-shim.ts`,
 * kept local so this module has no bundler dependency. Results are cached
 * per directory for the loader's lifetime (package.json does not change
 * mid-require in practice).
 */
const findOwningPackage = (
  vfs: VfsBus,
  modulePath: string,
  cache: Map<string, OwningPackage | undefined>,
): OwningPackage | undefined => {
  // The cache maps each visited dir to the package that OWNS it (the nearest
  // ancestor package.json), not to whether the dir itself has one — otherwise
  // a bare intermediate dir would short-circuit a later walk past it.
  let dir = dirname(modulePath);
  const trail: string[] = [];
  for (;;) {
    if (cache.has(dir)) {
      const hit = cache.get(dir);
      for (const d of trail) cache.set(d, hit);
      return hit;
    }
    trail.push(dir);

    const pkgJsonPath = joinPath(dir, "package.json");
    if (vfs.hot.existsSync(pkgJsonPath)) {
      let found: OwningPackage;
      try {
        const parsed = JSON.parse(vfs.hot.readFileSync(pkgJsonPath, "utf8") as string) as {
          name?: string;
          browser?: unknown;
        };
        found = { dir, name: parsed.name, browser: parsed.browser };
      } catch {
        found = { dir };
      }
      for (const d of trail) cache.set(d, found);
      return found;
    }
    if (dir === "/") {
      for (const d of trail) cache.set(d, undefined);
      return undefined;
    }
    dir = dirname(dir);
  }
};

/**
 * Applies the package's `browser` field to the `.node` path, mirroring the
 * bundler-time remap in `bundle.ts`: a string `browser` replaces the whole
 * package entry; an object maps `"./relative/path"` keys (and `"*"`) to
 * replacement specifiers, with `false` meaning "stub out entirely".
 * Returns the replacement specifier, `false` for an explicit stub, or
 * `undefined` when unmapped.
 */
const browserFieldRemap = (
  pkg: OwningPackage,
  modulePath: string,
): string | false | undefined => {
  const browser = pkg.browser;
  if (!browser) return undefined;
  if (typeof browser === "string") return browser;
  if (typeof browser !== "object") return undefined;
  const map = browser as Record<string, unknown>;

  const rel = modulePath.startsWith(`${pkg.dir}/`)
    ? `.${modulePath.slice(pkg.dir.length)}`
    : undefined;
  const candidates = rel
    ? [rel, rel.slice(2), rel.replace(/\.node$/, ""), `${rel.slice(0, -".node".length)}.js`]
    : [];
  for (const key of [...candidates, "*"]) {
    if (!(key in map)) continue;
    const value = map[key];
    if (value === false) return false;
    if (typeof value === "string") return value;
  }
  return undefined;
};

/**
 * Default `nativeAddonLoader` for `createLiveShimRegistry`: resolves a
 * `.node` require to a curated WASM/pure-JS variant and returns the exports
 * `warmWasmAddons` produced for it.
 *
 * Resolution order:
 * 1. Owning package.json `name` → {@link NATIVE_ADDON_WASM_VARIANTS}.
 * 2. Owning package.json `browser` field remap (string or object form).
 * 3. Catalogued `ERR_BOL_UNSUPPORTED_NATIVE_ADDON` naming the variant that
 *    would have satisfied the require.
 */
export const createWasmNativeAddonLoader = (
  options: WasmNativeAddonLoaderOptions,
): WasmNativeAddonLoader => {
  const { vfs, addons } = options;
  const variants = { ...NATIVE_ADDON_WASM_VARIANTS, ...options.variants };
  const pkgCache = new Map<string, OwningPackage | undefined>();

  return (modulePath: string, requireVfs?: VfsBus): unknown => {
    const fs = requireVfs ?? vfs;
    const pkg = findOwningPackage(fs, modulePath, pkgCache);

    let specifier: string | undefined;
    let via = "";
    if (pkg?.name && variants[pkg.name]) {
      specifier = variants[pkg.name];
      via = `native addon variant for "${pkg.name}"`;
    } else if (pkg) {
      const remapped = browserFieldRemap(pkg, modulePath);
      if (remapped === false) return {};
      if (typeof remapped === "string") {
        specifier = remapped;
        via = `browser-field remap in "${pkg.name ?? pkg.dir}"`;
      }
    }

    if (specifier === undefined) {
      throw cataloguedAddonError(
        "NATIVE_ADDON",
        `require("${modulePath}") is a native .node addon with no WASM variant. ` +
          `No entry in NATIVE_ADDON_WASM_VARIANTS${pkg?.name ? ` for "${pkg.name}"` : ""} ` +
          `and no browser-field remap applies.`,
      );
    }

    const hit = addons[specifier];
    if (hit !== undefined) return hit;

    throw cataloguedAddonError(
      "NATIVE_ADDON_COLD",
      `require("${modulePath}") resolved to "${specifier}" (${via}) but that variant ` +
        `has not been warmed. Call warmWasmAddons(["${specifier}"]) (or the full ` +
        `NATIVE_ADDON_WASM_VARIANTS set) before the first .node require — ` +
        `nativeAddonLoader is synchronous and cannot import() on demand.`,
    );
  };
};

export type WasmAddonModuleLoader = (specifier: string) => Promise<unknown>;

/**
 * esm.sh CDN loader — the same fallback `bundle.ts` uses for bare specifiers
 * the installed `node_modules` cannot satisfy. The variant packages are not
 * dependencies of `@bolojs/registry` (they are loaded on demand, only when a
 * `.node` require actually fires), so the CDN is the resolution path that
 * works in every realm without a lockfile change.
 */
export const esmShAddonModuleLoader: WasmAddonModuleLoader = async (specifier: string) => {
  const mod = (await import(/* @vite-ignore */ buildEsmShUrl(specifier))) as Record<
    string,
    unknown
  >;
  return mod.default ?? mod;
};

const warmedAddons = new Map<string, Promise<unknown>>();

/**
 * Import()s each variant specifier and returns `{ specifier: exports }`.
 * Module-level promise cache makes repeat calls (multiple process spawns in
 * one realm) free after the first warm. `importModule` is injectable for
 * tests and for hosts that prefer bundled specifiers over the esm.sh CDN.
 */
export const warmWasmAddons = async (
  specifiers: readonly string[],
  importModule: WasmAddonModuleLoader = esmShAddonModuleLoader,
): Promise<Record<string, unknown>> => {
  const out: Record<string, unknown> = {};
  await Promise.all(
    specifiers.map(async (specifier) => {
      let pending = warmedAddons.get(specifier);
      if (!pending) {
        pending = importModule(specifier);
        warmedAddons.set(specifier, pending);
      }
      out[specifier] = await pending;
    }),
  );
  return out;
};

/** Specifiers of every curated variant — the set `warmWasmAddons` needs. */
export const wasmAddonSpecifiers = (): string[] => Object.values(NATIVE_ADDON_WASM_VARIANTS);
