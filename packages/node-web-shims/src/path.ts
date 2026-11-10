import nodePath from "./path-node.js";

// Faithful vendored port of Node's lib/path.js — see path-node.ts. unenv's
// `node:path` delegates to pathe, which treats `\` as a separator on posix and
// collapses `//` prefixes incorrectly; both broke the upstream node test suite
// (`'' strictEqual 'bbb'`, `'//' strictEqual '/'`).

const path = nodePath;

export const resolve = path.resolve;
export const normalize = path.normalize;
export const isAbsolute = path.isAbsolute;
export const join = path.join;
export const relative = path.relative;
export const toNamespacedPath = path.toNamespacedPath;
export const dirname = path.dirname;
export const basename = path.basename;
export const extname = path.extname;
export const format = path.format;
export const parse = path.parse;
export const matchesGlob = path.matchesGlob;
export const sep = path.sep;
export const delimiter = path.delimiter;
export const posix = path.posix;
export const win32 = path.win32;
export const _makeLong = path.toNamespacedPath;

/**
 * Creates a node:path shim — real posix + win32 implementations ported from
 * Node's own lib/path.js.
 */
export const createPathShim = (): typeof path => {
  return path;
};

export default createPathShim();
