import unenvAssert from "unenv/node/assert";
import { inspect } from "./util.js";
import { AssertionError as NodeAssertionError } from "./util/assertion-error.js";
import { isDeepEqual, isDeepStrictEqual } from "./util/comparisons.js";
import { getErrMessage } from "./util/ok-expression.js";

export * from "unenv/node/assert";

const codedTypeError = (code: string, message: string): TypeError =>
  Object.assign(new TypeError(message), { code });

// unenv maps Node's internal argument-validation errors to bare `Error`
// (`ERR_MISSING_ARGS = Error`), so failures surface without `.code`. The
// compat suite asserts `deepStrictEqual(1)` → `{ code: 'ERR_MISSING_ARGS' }`,
// invalid `message` args → `ERR_INVALID_ARG_TYPE`, and rejects/doesNotReject
// validation failures → `ERR_INVALID_ARG_TYPE`/`ERR_INVALID_RETURN_VALUE`;
// validate and code those here instead.
/**
 * Argument validation shared by the comparison assertions: missing required
 * arguments throw ERR_MISSING_ARGS; a message that is neither a string nor
 * an Error throws ERR_INVALID_ARG_TYPE. (unenv does neither.)
 */
const checked = <A extends unknown[]>(
  argNames: string[],
  fn: (this: unknown, ...args: A) => void,
): ((...args: A) => void) =>
  function (...args: A) {
    if (args.length < argNames.length) {
      const missing = argNames
        .slice(args.length)
        .map((n) => `"${n}"`)
        .join(" and ");
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
  };

/**
 * Node's expected-type list formatting for ERR_INVALID_ARG_TYPE
 * (lib/internal/errors.js) — shared shape with buffer.ts.
 */
const K_TYPES = new Set([
  "string",
  "function",
  "number",
  "object",
  "Function",
  "Object",
  "boolean",
  "bigint",
  "symbol",
]);
const CLASS_RE = /^[A-Z][a-zA-Z0-9]*$/;
const formatTypeList = (array: string[], type = "or"): string => {
  switch (array.length) {
    case 0:
      return "";
    case 1:
      return `${array[0]}`;
    case 2:
      return `${array[0]} ${type} ${array[1]}`;
    case 3:
      return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(", ")}, ${type} ${array[array.length - 1]}`;
  }
};
const invalidArgType = (name: string, expected: string[], actual: unknown): TypeError => {
  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const value of expected) {
    // Node treats the lowercase built-in names as types and the
    // capitalised ones as constructors ("an instance of Error").
    if (K_TYPES.has(value) && value !== "Object") types.push(value.toLowerCase());
    else if (CLASS_RE.test(value)) instances.push(value);
    else other.push(value);
  }
  let msg = `The "${name}" argument must be `;
  if (types.length > 0) {
    msg += `${types.length > 1 ? "one of type" : "of type"} ${formatTypeList(types)}`;
    if (instances.length > 0 || other.length > 0) msg += " or ";
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatTypeList(instances)}`;
    if (other.length > 0) msg += " or ";
  }
  if (other.length > 0) {
    if (other.length > 1) msg += `one of ${formatTypeList(other)}`;
    else {
      if (other[0][0] !== other[0][0].toLowerCase()) msg += "an ";
      msg += other[0];
    }
  }
  msg += `. Received ${determineSpecificType(actual)}`;
  return codedTypeError("ERR_INVALID_ARG_TYPE", msg);
};

// ---------------------------------------------------------------------------
// Node's assert.rejects/doesNotReject/throws/doesNotThrow engine
// (lib/assert.js waitForActual + expectsError + expectedException), ported
// because unenv's copy loses error codes (its ERR_* are bare Error) and
// mis-detects Error subclasses (`expected instanceof Error` is false for
// `TypeError` the constructor, so class expectations take the validator path).
// ---------------------------------------------------------------------------

const NO_EXCEPTION_SENTINEL = {};
const AssertionErrorClass = NodeAssertionError as unknown as new (options: {
  actual?: unknown;
  expected?: unknown;
  message?: string;
  operator?: string;
  stackStartFn?: (...args: never[]) => unknown;
}) => Error & {
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  generatedMessage?: boolean;
};

type AssertFn = (...args: never[]) => unknown;

const innerFail = (obj: {
  actual?: unknown;
  expected?: unknown;
  message?: unknown;
  operator?: string;
  stackStartFn?: AssertFn;
}): never => {
  // Node: `if (obj.message instanceof Error) throw obj.message`.
  if (obj.message instanceof Error) throw obj.message;
  throw new AssertionErrorClass(obj as { message?: string });
};

/**
 * Brand-safe error check: `instanceof Error` fails for errors created in
 * another realm (e.g. inside `vm.runInNewContext`), which Node still treats
 * as errors.
 */
const isErrorLike = (value: unknown): value is Error =>
  value instanceof Error ||
  (typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Error]");

/** The constructor name of an error, across realms. */
const errorNameOf = (value: Error): string => {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? value.name;
};

const isErrorSubclass = (fn: unknown): boolean =>
  typeof fn === "function" &&
  ((fn as { prototype?: unknown }).prototype instanceof Error || fn === Error);

// Node's compareExceptionKey uses the real deepStrictEqual; unenv's exported
// predicate is a JSON.stringify approximation, so keep a small structural
// comparator for the validation-object path.
const exceptionKeyEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const rec = a as Record<string, unknown>;
  const reb = b as Record<string, unknown>;
  return aKeys.every((k) => k in reb && exceptionKeyEqual(rec[k], reb[k]));
};

class Comparison {
  [key: string]: unknown;
  constructor(obj: Record<string, unknown>, keys: string[], actual?: Record<string, unknown>) {
    for (const key of keys) {
      if (key in obj) {
        const a = actual?.[key];
        if (typeof a === "string" && obj[key] instanceof RegExp && (obj[key] as RegExp).test(a)) {
          this[key] = a;
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

const compareExceptionKey = (
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  key: string,
  message: unknown,
  keys: string[],
  fn: AssertFn,
): void => {
  if (!(key in actual) || !exceptionKeyEqual(actual[key], expected[key])) {
    if (!message) {
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);
      const err = new AssertionErrorClass({
        actual: a,
        expected: b,
        operator: "deepStrictEqual",
        stackStartFn: fn,
      }) as Error & { actual?: unknown; expected?: unknown; operator?: string };
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({
      actual,
      expected,
      message: message as string,
      operator: fn.name,
      stackStartFn: fn,
    });
  }
};

const expectedException = (
  actual: unknown,
  expected: unknown,
  message: unknown,
  fn: AssertFn,
): void => {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== "function") {
    if (expected instanceof RegExp) {
      const str = String(actual);
      if (expected.test(str)) return;
      if (!message) {
        generatedMessage = true;
        message =
          "The input did not match the regular expression " +
          `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
    } else if (typeof actual !== "object" || actual === null) {
      const err = new AssertionErrorClass({
        actual,
        expected,
        message: message as string | undefined,
        operator: "deepStrictEqual",
        stackStartFn: fn,
      }) as Error & { operator?: string; generatedMessage?: boolean };
      err.operator = fn.name;
      throw err;
    } else {
      const exp = expected as Record<string, unknown>;
      const keys = Object.keys(exp);
      if (expected instanceof Error) {
        keys.push("name", "message");
      } else if (keys.length === 0) {
        // Node: ERR_INVALID_ARG_VALUE('error', expected, 'may not be an empty object')
        throw codedTypeError(
          "ERR_INVALID_ARG_VALUE",
          `The argument 'error' may not be an empty object. Received ${inspect(expected)}`,
        );
      }
      const act = actual as Record<string, unknown>;
      for (const key of keys) {
        const expectedVal = exp[key];
        if (
          typeof act[key] === "string" &&
          expectedVal instanceof RegExp &&
          expectedVal.test(act[key] as string)
        ) {
          continue;
        }
        compareExceptionKey(act, exp, key, message, keys, fn);
      }
      return;
    }
  } else if (
    (expected as { prototype?: unknown }).prototype !== undefined &&
    actual instanceof (expected as Function)
  ) {
    return;
  } else if (isErrorSubclass(expected)) {
    if (!message) {
      generatedMessage = true;
      let msg =
        "The error is expected to be an instance of " +
        `"${(expected as { name?: string }).name}". Received `;
      if (isErrorLike(actual)) {
        const name = errorNameOf(actual);
        if ((expected as { name?: string }).name === name) {
          msg += "an error with identical name but a different prototype.";
        } else {
          msg += `"${name}"`;
        }
        if (actual.message) {
          msg += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        msg += `"${inspect(actual, { depth: -1 })}"`;
      }
      message = msg;
    }
    throwError = true;
  } else {
    const res = (expected as (...args: unknown[]) => unknown).call({}, actual);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = (expected as { name?: string }).name
          ? `"${(expected as { name?: string }).name}" `
          : "";
        message =
          `The ${name}validation function is expected to return` +
          ` "true". Received ${inspect(res)}`;
        if (actual instanceof Error) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionErrorClass({
      actual,
      expected,
      message: message as string,
      operator: fn.name,
      stackStartFn: fn,
    }) as Error & { generatedMessage?: boolean };
    err.generatedMessage = generatedMessage;
    throw err;
  }
};

const getActual = (fn: unknown): unknown => {
  if (typeof fn !== "function") {
    throw invalidArgType("fn", ["function"], fn);
  }
  try {
    (fn as () => unknown)();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
};

const checkIsPromise = (obj: unknown): boolean =>
  obj instanceof Promise ||
  (obj !== null &&
    typeof obj === "object" &&
    typeof (obj as { then?: unknown }).then === "function" &&
    typeof (obj as { catch?: unknown }).catch === "function");

const waitForActual = async (promiseFn: unknown): Promise<unknown> => {
  let resultPromise: unknown;
  if (typeof promiseFn === "function") {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = (promiseFn as () => unknown)();
    if (!checkIsPromise(resultPromise)) {
      throw codedTypeError(
        "ERR_INVALID_RETURN_VALUE",
        `Expected instance of Promise to be returned from the "promiseFn" function but got ${determineSpecificType(resultPromise)}.`,
      );
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw invalidArgType("promiseFn", ["Function", "Promise"], promiseFn);
  }
  try {
    await (resultPromise as Promise<unknown>);
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
};

const expectsError = (
  stackStartFn: AssertFn,
  actual: unknown,
  error: unknown,
  message: unknown,
  argCount: number,
): void => {
  if (typeof error === "string") {
    if (argCount === 4) {
      throw invalidArgType("error", ["Function", "Error", "RegExp", "Object"], error);
    }
    if (typeof actual === "object" && actual !== null) {
      if ((actual as { message?: unknown }).message === error) {
        throw codedTypeError(
          "ERR_AMBIGUOUS_ARGUMENT",
          `The "error/message" argument is ambiguous. The error message "${(actual as { message?: unknown }).message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw codedTypeError(
        "ERR_AMBIGUOUS_ARGUMENT",
        `The "error/message" argument is ambiguous. The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null && typeof error !== "object" && typeof error !== "function") {
    throw invalidArgType("error", ["Function", "Error", "RegExp", "Object"], error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = "";
    if (error && (error as { name?: unknown }).name) {
      details += ` (${(error as { name?: unknown }).name})`;
    }
    details += message ? `: ${message}` : ".";
    const fnType = stackStartFn === rejects ? "rejection" : "exception";
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
    });
  }

  if (!error) return;
  expectedException(actual, error, message, stackStartFn);
};

const hasMatchingError = (actual: unknown, expected: unknown): boolean => {
  if (typeof expected !== "function") {
    if (expected instanceof RegExp) {
      return expected.test(String(actual));
    }
    throw invalidArgType("expected", ["Function", "RegExp"], expected);
  }
  const exp = expected as { prototype?: unknown };
  if (exp.prototype !== undefined && actual instanceof (expected as Function)) {
    return true;
  }
  if (isErrorSubclass(expected)) {
    return false;
  }
  return (expected as (a: unknown) => unknown).call({}, actual) === true;
};

const expectsNoError = (
  stackStartFn: AssertFn,
  actual: unknown,
  error: unknown,
  message: unknown,
): void => {
  if (actual === NO_EXCEPTION_SENTINEL) return;
  if (typeof error === "string") {
    message = error;
    error = undefined;
  }
  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : ".";
    const fnType = stackStartFn === doesNotReject ? "rejection" : "exception";
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\nActual message: "${(actual as { message?: unknown })?.message}"`,
      stackStartFn,
    });
  }
  throw actual;
};

/** Brand-safe RegExp check (cross-realm regexes are still regexes). */
const isRegExpLike = (value: unknown): value is RegExp =>
  value instanceof RegExp || Object.prototype.toString.call(value) === "[object RegExp]";

/**
 * Node's `internalMatch` (lib/assert.js) — shared by `match` and
 * `doesNotMatch`. unenv's version throws a bare `Error('regexp')`.
 */
const internalMatch = (
  string: unknown,
  regexp: unknown,
  message: unknown,
  fn: AssertFn,
  expectMatch: boolean,
): void => {
  if (!isRegExpLike(regexp)) {
    throw invalidArgType("regexp", ["RegExp"], regexp);
  }
  if (typeof string !== "string" || (regexp.exec(string) !== null) !== expectMatch) {
    if (message instanceof Error) throw message;
    const generatedMessage = !message;
    const generated =
      typeof string !== "string"
        ? `The "string" argument must be of type string. Received type ${typeof string} (${inspect(string)})`
        : (expectMatch
            ? "The input did not match the regular expression "
            : "The input was expected to not match the regular expression ") +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`;
    const err = new AssertionErrorClass({
      actual: string,
      expected: regexp,
      message: (message as string) || generated,
      operator: fn.name,
      stackStartFn: fn,
    }) as Error & { generatedMessage?: boolean };
    err.generatedMessage = generatedMessage;
    throw err;
  }
};

const match = (string: unknown, regexp: unknown, message?: unknown): void => {
  internalMatch(string, regexp, message, match as unknown as AssertFn, true);
};

const doesNotMatch = (string: unknown, regexp: unknown, message?: unknown): void => {
  internalMatch(string, regexp, message, doesNotMatch as unknown as AssertFn, false);
};

const throws = (...args: unknown[]): void => {
  // Node: `assert.throws = function throws(promiseFn, ...args)` calls
  // `expectsError(throws, getActual(promiseFn), ...args)`, so the arity seen
  // by expectsError is 2 + rest.length — i.e. `args.length + 1` here.
  expectsError(throws as AssertFn, getActual(args[0]), args[1], args[2], args.length + 1);
};
const doesNotThrow = (...args: unknown[]): void => {
  expectsNoError(doesNotThrow as AssertFn, getActual(args[0]), args[1], args[2]);
};
const rejects = async (...args: unknown[]): Promise<void> => {
  expectsError(
    rejects as AssertFn,
    await waitForActual(args[0]),
    args[1],
    args[2],
    args.length + 1,
  );
};
const doesNotReject = async (...args: unknown[]): Promise<void> => {
  expectsNoError(doesNotReject as AssertFn, await waitForActual(args[0]), args[1], args[2]);
};

/**
 * Node's `determineSpecificType` (lib/internal/errors.js) — the "Received …"
 * half of ERR_INVALID_ARG_TYPE. Same rendering as buffer.ts's copy: strings
 * are single-quoted (JSON-quoted when they contain a quote, truncated past
 * 28 chars), numbers spell out NaN/Infinity/-0, objects name their
 * constructor.
 */
const determineSpecificType = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      if (value === 0) return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
      if (Number.isNaN(value)) return "type number (NaN)";
      if (value === Infinity) return "type number (Infinity)";
      if (value === -Infinity) return "type number (-Infinity)";
      return `type number (${value})`;
    case "boolean":
      return value ? "type boolean (true)" : "type boolean (false)";
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${(value as Function).name}`;
    case "object": {
      const ctor = (value as { constructor?: unknown }).constructor;
      // Node: `value.constructor && 'name' in value.constructor`, else
      // inspect(value, { depth: -1 }).
      if (
        ctor !== null &&
        ctor !== undefined &&
        (typeof ctor === "object" || typeof ctor === "function") &&
        "name" in (ctor as object)
      ) {
        return `an instance of ${(ctor as { name: unknown }).name}`;
      }
      return inspect(value, { depth: -1 });
    }
    case "string": {
      let s = value as string;
      if (s.length > 28) s = `${s.slice(0, 25)}...`;
      return s.includes("'") ? `type string (${JSON.stringify(s)})` : `type string ('${s}')`;
    }
    default:
      return `type ${typeof value} (${String(value)})`;
  }
};

// ---------------------------------------------------------------------------
// The comparison assertions (lib/assert.js) — ported from Node v22 because
// unenv's implementations use a JSON.stringify approximation and throw
// messages like `2 strictEqual '2'` instead of Node's diff.
// ---------------------------------------------------------------------------

const innerOk = (fn: AssertFn, argLen: number, value: unknown, message?: unknown): void => {
  if (value) return;
  let generatedMessage = false;
  if (argLen === 0) {
    generatedMessage = true;
    message = "No value argument passed to `assert.ok()`";
  } else if (message == null) {
    generatedMessage = true;
    message = getErrMessage(undefined, fn as (...args: never[]) => unknown);
  } else if (message instanceof Error) {
    throw message;
  }
  const err = new AssertionErrorClass({
    actual: value,
    expected: true,
    message: message as string,
    operator: "==",
    stackStartFn: fn,
  }) as Error & { generatedMessage?: boolean };
  err.generatedMessage = generatedMessage;
  throw err;
};

const ok = (...args: unknown[]): void => {
  innerOk(ok as AssertFn, args.length, args[0], args[1]);
};

const equal = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    // eslint-disable-next-line eqeqeq
    if (actual != expected && !(Number.isNaN(actual) && Number.isNaN(expected))) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "==",
        stackStartFn: equal as AssertFn,
      });
    }
  },
);

const notEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    // eslint-disable-next-line eqeqeq
    if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "!=",
        stackStartFn: notEqual as AssertFn,
      });
    }
  },
);

const deepEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (!isDeepEqual(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "deepEqual",
        stackStartFn: deepEqual as AssertFn,
      });
    }
  },
);

const notDeepEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (isDeepEqual(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "notDeepEqual",
        stackStartFn: notDeepEqual as AssertFn,
      });
    }
  },
);

const deepStrictEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (!isDeepStrictEqual(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "deepStrictEqual",
        stackStartFn: deepStrictEqual as AssertFn,
      });
    }
  },
);

const notDeepStrictEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (isDeepStrictEqual(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "notDeepStrictEqual",
        stackStartFn: notDeepStrictEqual as AssertFn,
      });
    }
  },
);

const strictEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (!Object.is(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "strictEqual",
        stackStartFn: strictEqual as AssertFn,
      });
    }
  },
);

const notStrictEqual = checked(
  ["actual", "expected"],
  function (this: unknown, actual: unknown, expected: unknown, message?: unknown): void {
    if (Object.is(actual, expected)) {
      innerFail({
        actual,
        expected,
        message: message as string | undefined,
        operator: "notStrictEqual",
        stackStartFn: notStrictEqual as AssertFn,
      });
    }
  },
);

/** Node's `assert.fail` (lib/assert.js). */
const fail = function (
  this: unknown,
  actual?: unknown,
  expected?: unknown,
  message?: unknown,
  operator?: string,
  stackStartFn?: AssertFn,
): never {
  const argsLen = arguments.length;
  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = "Failed";
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else if (argsLen === 2) {
    operator = "!=";
  }
  if (message instanceof Error) throw message;
  const err = new AssertionErrorClass({
    actual,
    expected,
    operator: operator === undefined ? "fail" : operator,
    stackStartFn: stackStartFn ?? (fail as AssertFn),
    message: message as string | undefined,
  }) as Error & { generatedMessage?: boolean };
  if (internalMessage) err.generatedMessage = true;
  throw err;
};

// Callable `assert(value)` — same shape as Node (`module.exports = assert`).
const assert = Object.assign((...args: unknown[]) => ok(...args), unenvAssert, {
  ok,
  fail,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  match,
  doesNotMatch,
});

// Node's AssertionError (with the v22 diff rendering) replaces unenv's.
assert.AssertionError = NodeAssertionError as unknown as typeof assert.AssertionError;

// `assert.strict` — the strict-mode facade (`equal` → `strictEqual`, etc.).
const strict = Object.assign((...args: unknown[]) => ok(...args), assert, {
  equal: strictEqual,
  deepEqual: deepStrictEqual,
  notEqual: notStrictEqual,
  notDeepEqual: notDeepStrictEqual,
});
strict.strict = strict;
strict.AssertionError = assert.AssertionError;
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

export { ok, fail };
export { throws, doesNotThrow, rejects, doesNotReject };
export const ifError = assert.ifError;
export { match, doesNotMatch };
export const AssertionError = NodeAssertionError;
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
