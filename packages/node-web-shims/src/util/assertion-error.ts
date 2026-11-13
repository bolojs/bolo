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

const kMaxShortLength = 12;

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

const createErrDiff = (actual: unknown, expected: unknown, operator: string): string => {
  let other = "";
  let res = "";
  let end = "";
  let skipped = false;
  const actualInspected = inspectValue(actual);
  const actualLines = actualInspected.split("\n");
  const expectedLines = inspectValue(expected).split("\n");

  let i = 0;
  let indicator = "";

  if (
    operator === "strictEqual" &&
    ((typeof actual === "object" &&
      actual !== null &&
      typeof expected === "object" &&
      expected !== null) ||
      (typeof actual === "function" && typeof expected === "function"))
  ) {
    operator = "strictEqualObject";
  }

  if (
    actualLines.length === 1 &&
    expectedLines.length === 1 &&
    actualLines[0] !== expectedLines[0]
  ) {
    const actualRaw = actualLines[0];
    const expectedRaw = expectedLines[0];
    const inputLength = actualRaw.length + expectedRaw.length;
    if (inputLength <= kMaxShortLength) {
      if (
        (typeof actual !== "object" || actual === null) &&
        (typeof expected !== "object" || expected === null) &&
        (actual !== 0 || expected !== 0)
      ) {
        return `${kReadableOperator[operator]}\n\n${actualLines[0]} !== ${expectedLines[0]}\n`;
      }
    } else if (operator !== "strictEqualObject") {
      const maxLength = 80;
      if (inputLength < maxLength) {
        while (actualRaw[i] === expectedRaw[i]) {
          i += 1;
        }
        if (i > 2) {
          indicator = `\n  ${" ".repeat(i)}^`;
          i = 0;
        }
      }
    }
  }

  let a = actualLines[actualLines.length - 1];
  let b = expectedLines[expectedLines.length - 1];
  while (a === b) {
    if (i++ < 3) {
      end = `\n  ${a}${end}`;
    } else {
      other = a;
    }
    actualLines.pop();
    expectedLines.pop();
    if (actualLines.length === 0 || expectedLines.length === 0) break;
    a = actualLines[actualLines.length - 1];
    b = expectedLines[expectedLines.length - 1];
  }

  const maxLines = Math.max(actualLines.length, expectedLines.length);
  if (maxLines === 0) {
    const allLines = actualInspected.split("\n");
    if (allLines.length > 50) {
      allLines[46] = `${colors.blue}...${colors.white}`;
      while (allLines.length > 47) {
        allLines.pop();
      }
    }
    return `${kReadableOperator.notIdentical}\n\n${allLines.join("\n")}\n`;
  }

  if (i >= 5) {
    end = `\n${colors.blue}...${colors.white}${end}`;
    skipped = true;
  }
  if (other !== "") {
    end = `\n  ${other}${end}`;
    other = "";
  }

  let printedLines = 0;
  let identical = 0;
  const msg =
    kReadableOperator[operator] +
    `\n${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;
  const skippedMsg = ` ${colors.blue}...${colors.white} Lines skipped`;

  let lines = actualLines;
  let plusMinus = `${colors.green}+${colors.white}`;
  let maxLength = expectedLines.length;
  if (actualLines.length < maxLines) {
    lines = expectedLines;
    plusMinus = `${colors.red}-${colors.white}`;
    maxLength = actualLines.length;
  }

  for (i = 0; i < maxLines; i += 1) {
    if (maxLength < i + 1) {
      if (identical > 2) {
        if (identical > 3) {
          if (identical > 4) {
            if (identical === 5) {
              res += `\n  ${lines[i - 3]}`;
              printedLines += 1;
            } else {
              res += `\n${colors.blue}...${colors.white}`;
              skipped = true;
            }
          }
          res += `\n  ${lines[i - 2]}`;
          printedLines += 1;
        }
        res += `\n  ${lines[i - 1]}`;
        printedLines += 1;
      }
      identical = 0;
      if (lines === actualLines) {
        res += `\n${plusMinus} ${lines[i]}`;
      } else {
        other += `\n${plusMinus} ${lines[i]}`;
      }
      printedLines += 1;
    } else {
      const expectedLine = expectedLines[i];
      let actualLine = actualLines[i];
      let divergingLines =
        actualLine !== expectedLine &&
        (!actualLine.endsWith(",") || actualLine.slice(0, -1) !== expectedLine);
      if (
        divergingLines &&
        expectedLine.endsWith(",") &&
        expectedLine.slice(0, -1) === actualLine
      ) {
        divergingLines = false;
        actualLine += ",";
      }
      if (divergingLines) {
        if (identical > 2) {
          if (identical > 3) {
            if (identical > 4) {
              if (identical === 5) {
                res += `\n  ${actualLines[i - 3]}`;
                printedLines += 1;
              } else {
                res += `\n${colors.blue}...${colors.white}`;
                skipped = true;
              }
            }
            res += `\n  ${actualLines[i - 2]}`;
            printedLines += 1;
          }
          res += `\n  ${actualLines[i - 1]}`;
          printedLines += 1;
        }
        identical = 0;
        res += `\n${colors.green}+${colors.white} ${actualLine}`;
        other += `\n${colors.red}-${colors.white} ${expectedLine}`;
        printedLines += 2;
      } else {
        res += other;
        other = "";
        identical += 1;
        if (identical <= 2) {
          res += `\n  ${actualLine}`;
          printedLines += 1;
        }
      }
    }
    if (printedLines > 50 && i < maxLines - 2) {
      return `${msg}${skippedMsg}\n${res}\n${colors.blue}...${colors.white}${other}\n${colors.blue}...${colors.white}`;
    }
  }

  return `${msg}${skipped ? skippedMsg : ""}\n${res}${other}${end}${indicator}`;
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
      super(String(message));
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
