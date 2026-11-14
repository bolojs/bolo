/**
 * Port of Node v22 `lib/internal/assert/assertion_error.js`.
 *
 * unenv's `AssertionError` produces messages like
 * `2 notStrictEqual 2`; Node produces a diff:
 *
 *     Expected values to be strictly unequal:
 *
 *     2 !== 2
 *
 * The compat suite asserts the Node wording, so the diff rendering lives
 * here and `assert.ts` throws this class instead.
 *
 * Differences from upstream:
 * - `internal/util/inspect` is the shim's `inspect`.
 * - `internal/util/colors` is the shim's `colors` map (no ANSI colours by
 *   default, so the diff output matches Node's non-tty output).
 * - `isErrorStackTraceLimitWritable` is not available; the stack limit is
 *   left untouched.
 */

import { inspect, customInspectSymbol } from "./inspect.js";
import { colors } from "./colors.js";

type InspectContext = {
  colors?: boolean;
  depth?: number;
  showHidden?: boolean;
  [key: string]: unknown;
};

const kReadableOperator: Record<string, string> = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: "Values have same structure but are not reference-equal:",
  notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
};

const kMaxShortStringLength = 12;

/**
 * Node's `determineSpecificType` (lib/internal/errors.js) — the "Received …"
 * half of ERR_INVALID_ARG_TYPE.
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

/** Node's `validateObject(value, name)` (lib/internal/validators.js). */
const invalidArgType = (name: string, expected: string[], actual: unknown): TypeError => {
  const message = `The "${name}" argument must be of type ${expected.join(" or ")}. Received ${determineSpecificType(actual)}`;
  return Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
};

const copyError = <T extends Error>(source: T): T => {
  const keys = Object.keys(source);
  const target = Object.create(Object.getPrototypeOf(source)) as T;
  for (const key of keys) {
    (target as unknown as Record<string, unknown>)[key] = (
      source as unknown as Record<string, unknown>
    )[key];
  }
  Object.defineProperty(target, "message", { value: source.message });
  return target;
};

const inspectValue = (val: unknown): string =>
  inspect(val, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Number.POSITIVE_INFINITY,
    showHidden: false,
    showProxy: false,
    sorted: true,
    getters: true,
  });

/**
 * Node's `myersDiff` (lib/internal/assert/myers_diff.js).
 *
 * The diff is computed over *lines* (or characters for the simple string
 * variant) and rendered with the `+`/`-`/` ` prefixes the compat suite
 * asserts on. The shim previously approximated this with a hand-rolled
 * line-matching loop, which diverged from Node on the trailing newline, on
 * grouped nop lines and on comma-disparity handling — so port the upstream
 * algorithm verbatim.
 */
const kNopLinesToCollapse = 5;

type DiffOp = { type: "nop" | "insert" | "delete"; value: string };

const areLinesEqual = (actual: string, expected: string, checkCommaDisparity: boolean): boolean => {
  if (actual === expected) return true;
  if (checkCommaDisparity) {
    return `${actual},` === expected || actual === `${expected},`;
  }
  return false;
};

const myersDiff = (actual: string[], expected: string[], checkCommaDisparity = false): DiffOp[] => {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;
  // V8 array-fill semantics required: the trace slices `v` per diff level.
  const v: number[] = Array.from({ length: 2 * max + 1 }, () => 0);

  const trace: number[][] = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    trace.push(v.slice());

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      let x: number;
      if (
        diagonalIndex === -diffLevel ||
        (diagonalIndex !== diffLevel && v[diagonalIndex - 1 + max] < v[diagonalIndex + 1 + max])
      ) {
        x = v[diagonalIndex + 1 + max];
      } else {
        x = v[diagonalIndex - 1 + max] + 1;
      }

      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        areLinesEqual(actual[x], expected[y], checkCommaDisparity)
      ) {
        x++;
        y++;
      }

      v[diagonalIndex + max] = x;

      if (x >= actualLength && y >= expectedLength) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }

  return [];
};

const backtrack = (
  trace: number[][],
  actual: string[],
  expected: string[],
  checkCommaDisparity: boolean,
): DiffOp[] => {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result: DiffOp[] = [];

  for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
    const v = trace[diffLevel];
    const diagonalIndex = x - y;
    let prevDiagonalIndex: number;

    if (
      diagonalIndex === -diffLevel ||
      (diagonalIndex !== diffLevel && v[diagonalIndex - 1 + max] < v[diagonalIndex + 1 + max])
    ) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = v[prevDiagonalIndex + max];
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      const value =
        !checkCommaDisparity || actual[x - 1].endsWith(",") ? actual[x - 1] : expected[y - 1];
      result.push({ type: "nop", value });
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        result.push({ type: "insert", value: actual[x - 1] });
        x--;
      } else {
        result.push({ type: "delete", value: expected[y - 1] });
        y--;
      }
    }
  }

  return result;
};

const printSimpleMyersDiff = (diff: DiffOp[]): string => {
  let message = "";

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { type, value } = diff[diffIdx];
    if (type === "insert") {
      message += `${colors.green}${value}${colors.white}`;
    } else if (type === "delete") {
      message += `${colors.red}${value}${colors.white}`;
    } else {
      message += `${colors.white}${value}${colors.white}`;
    }
  }

  return `\n${message}`;
};

const printMyersDiff = (diff: DiffOp[]): { message: string; skipped: boolean } => {
  let message = "";
  let skipped = false;
  let nopCount = 0;

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { type, value } = diff[diffIdx];
    const previousType = diffIdx < diff.length - 1 ? diff[diffIdx + 1].type : null;
    const typeChanged = previousType && type !== previousType;

    if (typeChanged && previousType === "nop") {
      // Avoid grouping if only one line would have been grouped otherwise
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `${colors.white}  ${diff[diffIdx + 1].value}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `${colors.white}  ${diff[diffIdx + 2].value}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1].value}\n`;
      }
      if (nopCount >= kNopLinesToCollapse + 3) {
        message += `${colors.blue}...${colors.white}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1].value}\n`;
        skipped = true;
      }
      nopCount = 0;
    }

    if (type === "insert") {
      message += `${colors.green}+${colors.white} ${value}\n`;
    } else if (type === "delete") {
      message += `${colors.red}-${colors.white} ${value}\n`;
    } else if (type === "nop") {
      if (nopCount < kNopLinesToCollapse) {
        message += `${colors.white}  ${value}\n`;
      }
      nopCount++;
    }
  }

  message = message.trimEnd();

  return { message: `\n${message}`, skipped };
};

/** Node's `isSimpleDiff` (lib/internal/assert/assertion_error.js). */
const isSimpleDiff = (
  actual: unknown,
  inspectedActual: string[],
  expected: unknown,
  inspectedExpected: string[],
): boolean => {
  if (inspectedActual.length > 1 || inspectedExpected.length > 1) {
    return false;
  }

  return (
    typeof actual !== "object" ||
    actual === null ||
    typeof expected !== "object" ||
    expected === null
  );
};

/** Node's `getStackedDiff` (lib/internal/assert/assertion_error.js). */
const getStackedDiff = (
  originalActual: unknown,
  actual: string,
  originalExpected: unknown,
  expected: string,
): { message: string; header: string; skipped: boolean } => {
  const isStringComparison =
    typeof originalActual === "string" && typeof originalExpected === "string";

  let message = `\n${colors.green}+${colors.white} ${actual}\n${colors.red}- ${colors.white}${expected}`;
  const stringsLen = actual.length + expected.length;
  const maxTerminalLength = 80;
  const showIndicator = isStringComparison && stringsLen <= maxTerminalLength;

  if (showIndicator) {
    let indicatorIdx = -1;

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        // Skip the indicator for the first 2 characters because the diff is
        // immediately apparent (it is 3 instead of 2 to account for the quotes).
        if (i >= 3) {
          indicatorIdx = i;
        }
        break;
      }
    }

    if (indicatorIdx !== -1) {
      message += `\n${" ".repeat(indicatorIdx + 2)}^`;
    }
  }

  return { message, header: "+ actual - expected", skipped: false };
};

/** Node's `getSimpleDiff` (lib/internal/assert/assertion_error.js). */
const getSimpleDiff = (
  originalActual: unknown,
  actual: string,
  originalExpected: unknown,
  expected: string,
): { message: string; header: string; skipped: boolean } => {
  let stringsLen = actual.length + expected.length;
  // Accounting for the quotes wrapping strings
  if (typeof originalActual === "string") {
    stringsLen -= 2;
  }
  if (typeof originalExpected === "string") {
    stringsLen -= 2;
  }
  if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
    return { message: `${actual} !== ${expected}`, header: "", skipped: false };
  }

  const isStringComparison =
    typeof originalActual === "string" && typeof originalExpected === "string";
  if (isStringComparison && colors.hasColors()) {
    const diff = myersDiff(actual.split(""), expected.split(""));
    return { message: printSimpleMyersDiff(diff), header: "actual expected", skipped: false };
  }

  return getStackedDiff(originalActual, actual, originalExpected, expected);
};

/** Node's `checkOperator` (lib/internal/assert/assertion_error.js). */
const checkOperator = (actual: unknown, expected: unknown, operator: string): string => {
  if (
    operator === "strictEqual" &&
    ((typeof actual === "object" &&
      actual !== null &&
      typeof expected === "object" &&
      expected !== null) ||
      (typeof actual === "function" && typeof expected === "function"))
  ) {
    return "strictEqualObject";
  }

  return operator;
};

const createErrDiff = (
  actual: unknown,
  expected: unknown,
  operator: string,
  customMessage?: string,
): string => {
  operator = checkOperator(actual, expected, operator);

  let skipped = false;
  let message = "";
  const inspectedActual = inspectValue(actual);
  const inspectedExpected = inspectValue(expected);
  const inspectedSplitActual = inspectedActual.split("\n");
  const inspectedSplitExpected = inspectedExpected.split("\n");
  const showSimpleDiff = isSimpleDiff(
    actual,
    inspectedSplitActual,
    expected,
    inspectedSplitExpected,
  );
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;

  if (showSimpleDiff) {
    const simpleDiff = getSimpleDiff(
      actual,
      inspectedSplitActual[0],
      expected,
      inspectedSplitExpected[0],
    );
    message = simpleDiff.message;
    if (typeof simpleDiff.header !== "undefined") {
      header = simpleDiff.header;
    }
    if (simpleDiff.skipped) {
      skipped = true;
    }
  } else if (inspectedActual === inspectedExpected) {
    // Handles the case where the objects are structurally the same but
    // different references.
    operator = "notIdentical";
    if (inspectedSplitActual.length > 50) {
      message = `${inspectedSplitActual.slice(0, 50).join("\n")}\n...}`;
      skipped = true;
    } else {
      message = inspectedSplitActual.join("\n");
    }
    header = "";
  } else {
    const checkCommaDisparity = actual != null && typeof actual === "object";
    const diff = myersDiff(inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity);

    const myersDiffMessage = printMyersDiff(diff);
    message = myersDiffMessage.message;

    if (myersDiffMessage.skipped) {
      skipped = true;
    }
  }

  const headerMessage = `${customMessage || kReadableOperator[operator]}\n${header}`;
  const skippedMessage = skipped ? "\n... Skipped lines" : "";

  return `${headerMessage}${skippedMessage}\n${message}\n`;
};

const addEllipsis = (string: string): string => {
  const lines = string.split("\n");
  if (lines.length > 10) {
    lines.length = 10;
    return `${lines.join("\n")}\n...`;
  }
  if (string.length > 512) {
    // Node uses `StringPrototypeSlice(string, 512)`, i.e. `slice(512)`, which
    // keeps the TAIL of the string (not the first 512 characters).
    return `${string.slice(512)}...`;
  }
  return string;
};

export interface AssertionErrorOptions {
  actual?: unknown;
  expected?: unknown;
  message?: string | Error;
  operator?: string;
  stackStartFn?: (...args: never[]) => unknown;
  details?: unknown[];
}

/** Node v22's `AssertionError` (lib/internal/assert/assertion_error.js). */
export class AssertionError extends Error {
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  generatedMessage?: boolean;
  code = "ERR_ASSERTION";

  constructor(options?: AssertionErrorOptions) {
    // Node: `validateObject(options, 'options')` — `undefined` is rejected too,
    // so no default parameter here.
    if (typeof options !== "object" || options === null) {
      throw invalidArgType("options", ["object"], options);
    }
    const { message, operator, stackStartFn, details } = options;
    let { actual, expected } = options;

    if (message != null) {
      // Node: a custom message on the diff operators is used as the diff
      // header instead of the readable operator text (`oh no\n\n1 !== 2\n`).
      if (operator === "deepStrictEqual" || operator === "strictEqual") {
        super(createErrDiff(actual, expected, operator, String(message)));
      } else {
        super(String(message));
      }
    } else {
      if (
        typeof actual === "object" &&
        actual !== null &&
        typeof expected === "object" &&
        expected !== null &&
        "stack" in actual &&
        actual instanceof Error &&
        "stack" in expected &&
        expected instanceof Error
      ) {
        actual = copyError(actual);
        expected = copyError(expected);
      }

      if (operator === "deepStrictEqual" || operator === "strictEqual") {
        super(createErrDiff(actual, expected, operator));
      } else if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") {
        let base = kReadableOperator[operator];
        const res = inspectValue(actual).split("\n");

        if (
          operator === "notStrictEqual" &&
          ((typeof actual === "object" && actual !== null) || typeof actual === "function")
        ) {
          base = kReadableOperator.notStrictEqualObject;
        }

        if (res.length > 50) {
          res[46] = `${colors.blue}...${colors.white}`;
          while (res.length > 47) {
            res.pop();
          }
        }

        if (res.length === 1) {
          super(`${base}${res[0].length > 5 ? "\n\n" : " "}${res[0]}`);
        } else {
          super(`${base}\n\n${res.join("\n")}\n`);
        }
      } else {
        let res = inspectValue(actual);
        let other = inspectValue(expected);
        const knownOperator = kReadableOperator[operator ?? ""] ?? "";
        if (operator === "notDeepEqual" && res === other) {
          res = `${knownOperator}\n\n${res}`;
          if (res.length > 1024) {
            res = `${res.slice(0, 1021)}...`;
          }
          super(res);
        } else {
          if (res.length > 512) {
            res = `${res.slice(0, 509)}...`;
          }
          if (other.length > 512) {
            other = `${other.slice(0, 509)}...`;
          }
          if (operator === "deepEqual") {
            res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
          } else {
            const newOp = kReadableOperator[`${operator}Unequal`];
            if (newOp) {
              res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
            } else {
              other = ` ${operator} ${other}`;
            }
          }
          super(`${res}${other}`);
        }
      }
    }

    this.name = "AssertionError";
    this.generatedMessage = message === undefined;

    if (details !== undefined && Array.isArray(details) && details.length > 0) {
      this.actual = details;
      this.expected = undefined;
    } else {
      this.actual = actual;
      this.expected = expected;
    }

    this.operator = operator;

    const stackStart =
      stackStartFn ??
      ((): never => {
        throw new Error("Missing stack start function");
      });
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, stackStart as (this: unknown, ...args: never[]) => void);
    }
    // Trigger the stack getter so the stack is materialised eagerly.
    void this.stack;
    this.name = "AssertionError";
  }

  toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  /**
   * Node's `AssertionError[inspect.custom]`: long strings in `actual` /
   * `expected` are truncated, and the object is inspected at depth 0 so the
   * error message is not repeated inside the inspected output.
   */
  [customInspectSymbol](recurseTimes: number, ctx: InspectContext): string {
    const tmpActual = this.actual;
    const tmpExpected = this.expected;

    if (typeof this.actual === "string") {
      this.actual = addEllipsis(this.actual);
    }
    if (typeof this.expected === "string") {
      this.expected = addEllipsis(this.expected);
    }

    const result = inspect(this, {
      ...ctx,
      customInspect: false,
      depth: 0,
    });

    this.actual = tmpActual;
    this.expected = tmpExpected;

    return result;
  }
}
