import unenvAssert from "unenv/node/assert";

export * from "unenv/node/assert";

const codedTypeError = (code: string, message: string): TypeError =>
  Object.assign(new TypeError(message), { code });

// unenv maps Node's internal argument-validation errors to bare `Error`
// (`ERR_MISSING_ARGS = Error`), so failures surface without `.code`. The
// compat suite asserts `deepStrictEqual(1)` → `{ code: 'ERR_MISSING_ARGS' }`
// and invalid `message` args → `ERR_INVALID_ARG_TYPE`; validate here instead.
const wrapChecked = <A extends unknown[], R>(
  fn: (...args: A) => R,
  argNames: string[],
): ((...args: A) => R) =>
  ((...args: A) => {
    if (args.length < argNames.length) {
      const missing = argNames
        .slice(args.length)
        .map((n) => `"${n}"`)
        .join(", ");
      throw codedTypeError(
        "ERR_MISSING_ARGS",
        `The ${missing} argument${args.length + 1 === argNames.length ? "" : "s"} must be specified`,
      );
    }
    const message = args[argNames.length];
    if (message !== undefined && typeof message !== "string" && !(message instanceof Error)) {
      throw codedTypeError(
        "ERR_INVALID_ARG_TYPE",
        'The "message" argument must be of type string or an instance of Error',
      );
    }
    return fn(...args);
  }) as (...args: A) => R;

const deepStrictEqual = wrapChecked(unenvAssert.deepStrictEqual, ["actual", "expected"]);
const notDeepStrictEqual = wrapChecked(unenvAssert.notDeepStrictEqual, ["actual", "expected"]);
const strictEqual = wrapChecked(unenvAssert.strictEqual, ["actual", "expected"]);
const notStrictEqual = wrapChecked(unenvAssert.notStrictEqual, ["actual", "expected"]);
const equal = wrapChecked(unenvAssert.equal, ["actual", "expected"]);
const notEqual = wrapChecked(unenvAssert.notEqual, ["actual", "expected"]);
const deepEqual = wrapChecked(unenvAssert.deepEqual, ["actual", "expected"]);
const notDeepEqual = wrapChecked(unenvAssert.notDeepEqual, ["actual", "expected"]);

// Callable `assert(value)` — same shape as Node (`module.exports = assert`).
const assert = Object.assign(
  (...args: Parameters<typeof unenvAssert.ok>) => unenvAssert.ok(...args),
  unenvAssert,
  {
    deepStrictEqual,
    notDeepStrictEqual,
    strictEqual,
    notStrictEqual,
    equal,
    notEqual,
    deepEqual,
    notDeepEqual,
  },
);

// `assert.strict` — the strict-mode facade (`equal` → `strictEqual`, etc.).
const strict = Object.assign(
  (...args: Parameters<typeof unenvAssert.ok>) => unenvAssert.ok(...args),
  assert,
  {
    equal: strictEqual,
    deepEqual: deepStrictEqual,
    notEqual: notStrictEqual,
    notDeepEqual: notDeepStrictEqual,
  },
);
strict.strict = strict;
assert.strict = strict;

export {
  strict,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
};

export const ok = assert.ok;
export const fail = assert.fail;
export const throws = assert.throws;
export const doesNotThrow = assert.doesNotThrow;
export const rejects = assert.rejects;
export const doesNotReject = assert.doesNotReject;
export const ifError = assert.ifError;
export const match = assert.match;
export const doesNotMatch = assert.doesNotMatch;
export const AssertionError = assert.AssertionError;
export const CallTracker = assert.CallTracker;
export const partialDeepStrictEqual = assert.partialDeepStrictEqual;

/**
 * Creates a node:assert shim — unenv's assert (with the patched
 * AssertionError) plus Node's argument-validation error codes.
 */
export const createAssertShim = (): typeof assert => {
  return assert;
};

export default createAssertShim();
