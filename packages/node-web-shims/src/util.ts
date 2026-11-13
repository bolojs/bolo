import unenvUtil from "unenv/node/util";
import { promisify as unenvPromisify } from "unenv/node/util";
import unenvTypes from "unenv/node/util/types";

import { customInspectSymbol, format, formatWithOptions, inspect } from "./util/inspect.js";

export * from "unenv/node/util";

export { format, formatWithOptions, inspect };
export type { InspectOptions } from "./util/inspect.js";

// unenv's util.mjs imports `node:util/types` itself, which lands as a dead
// `browser_external_*` namespace in consumer bundles — import the real,
// self-contained module directly instead.
export const types = unenvTypes;

/**
 * unenv's `promisify()` reads its own custom-promisify symbol (not Node's
 * `Symbol.for("nodejs.util.promisify.custom")`). Expose it so other shims
 * can tag their functions with the symbol unenv's promisify actually reads.
 */
export const customPromisifySymbol = (unenvUtil as unknown as { promisify: { custom: symbol } })
  .promisify.custom;

/**
 * `util.promisify` — Node reads `Symbol.for("nodejs.util.promisify.custom")`
 * (and keeps `.custom` pointing at it). unenv's version reads its own
 * module-local symbol, so a function tagged with Node's symbol (or vice
 * versa) is invisible. Try both.
 */
const promisify = <F extends (...args: any[]) => any>(fn: F) => {
  const tagged =
    (fn as Record<PropertyKey, unknown>)[Symbol.for("nodejs.util.promisify.custom")] ??
    (fn as Record<PropertyKey, unknown>)[customPromisifySymbol];
  if (tagged) return tagged as (...args: Parameters<F>) => Promise<unknown>;
  return unenvPromisify(fn as never);
};
promisify.custom = Symbol.for("nodejs.util.promisify.custom");

export const callbackify = <T extends unknown[]>(fn: (...args: [...T]) => Promise<unknown>) => {
  const callbackified = (...args: [...T, (err: unknown, value?: unknown) => void]) => {
    const cb = args.pop() as (err: unknown, value?: unknown) => void;
    Promise.resolve()
      .then(() => fn(...(args as unknown as T)))
      .then(
        (v) => cb(null, v),
        (e) => cb(e),
      );
  };
  return callbackified;
};

export const toUSVString = (val: unknown): string => {
  const s = String(val);
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
};

const util = {
  ...unenvUtil,
  types: unenvTypes,
  inspect,
  format,
  formatWithOptions,
  callbackify,
  toUSVString,
  promisify,
};

/**
 * Creates a node:util shim. Overrides unenv's `format`/`inspect` (which broke
 * on non-string format args and circular objects) and wires `types` to the
 * real `unenv/node/util/types` module rather than the dead `node:util/types`
 * import inside unenv's util.
 */
export const createUtilShim = (): typeof util => {
  return util;
};

export { customInspectSymbol };

export default createUtilShim();
