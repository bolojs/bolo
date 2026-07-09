/**
 * Builds an esm.sh CDN URL for a package. Shared by `PackageManager`'s
 * install-time import map and `wasm-registry`'s bundle-time esm.sh fallback
 * (bare imports that can't be resolved off the installed `node_modules`).
 */
export const buildEsmShUrl = (name: string, version?: string, external = false, trailingSlash = false): string => {
  const versionPart = version ? `@${version}` : '';
  const prefix = external ? '*' : '';
  const suffix = trailingSlash ? '/' : '';
  return `https://esm.sh/${prefix}${name}${versionPart}${suffix}`;
};
