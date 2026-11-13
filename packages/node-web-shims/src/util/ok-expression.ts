/**
 * Port of Node v22's `assert.ok()` expression extraction
 * (lib/assert.js `getErrMessage` + `getCode`/`parseCode`).
 *
 * When `assert.ok(value)` is called without a message, Node reads the
 * caller's source file and reports the expression that evaluated to a falsy
 * value:
 *
 *     The expression evaluated to a falsy value:
 *
 *       assert.ok(
 *         typeof 123 === 'string'
 *       )
 *
 * In a browser there is no synchronous filesystem, so the source is read
 * through a pluggable reader. Hosts that can prefetch sources (a bundler
 * plugin, an ESM loader with source text, etc.) install a reader via
 * `setOkExpressionSourceReader`; without one the shim falls back to the
 * message Node produces when it cannot recover the expression (`<null>`).
 */

type CallSite = {
  getFileName(): string | null | undefined;
  getLineNumber(): number;
  getColumnNumber(): number;
};

/**
 * V8 exposes the stack as a string (the structured `CallSite` array is a
 * V8-only API that Node enables through `overrideStackTrace`). Browsers only
 * give the string form, so the first frame is parsed out of it.
 */
const parseFirstFrame = (
  stack: string,
  accept?: (frame: { filename: string; text: string }) => boolean,
): CallSite | undefined => {
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);
    const match = /\(?([^()]+):(\d+):(\d+)\)?$/.exec(body);
    if (!match) continue;
    const [, filename, lineNo, columnNo] = match;
    const name = filename.trim();
    if (accept && !accept({ filename: name, text: body })) continue;
    return {
      getFileName: () => name,
      getLineNumber: () => Number(lineNo),
      getColumnNumber: () => Number(columnNo),
    };
  }
  return undefined;
};

const errorCache = new Map<string, string | undefined>();

type SourceReader = (filename: string) => string | undefined;

let readSource: SourceReader | undefined;

/** Installs the (host-provided) source reader used by `assert.ok`. */
export const setOkExpressionSourceReader = (reader: SourceReader | undefined): void => {
  readSource = reader;
};

const globalReader = (): SourceReader | undefined => {
  const g = globalThis as { __boloOkExpressionSourceReader?: SourceReader };
  return g.__boloOkExpressionSourceReader;
};

const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  "\\u0000",
  "\\u0001",
  "\\u0002",
  "\\u0003",
  "\\u0004",
  "\\u0005",
  "\\u0006",
  "\\u0007",
  "\\b",
  "",
  "",
  "\\u000b",
  "\\f",
  "",
  "\\u000e",
  "\\u000f",
  "\\u0010",
  "\\u0011",
  "\\u0012",
  "\\u0013",
  "\\u0014",
  "\\u0015",
  "\\u0016",
  "\\u0017",
  "\\u0018",
  "\\u0019",
  "\\u001a",
  "\\u001b",
  "\\u001e",
  "\\u001f",
];
const escapeFn = (str: string): string => meta[(str as string).charCodeAt(0)];

/**
 * Node's `parseCode` (lib/assert.js): find the CallExpression that encloses
 * `offset` in `code` and return `[start, text]`.
 *
 * Node uses acorn; the shim uses a small scanner: from the call-site column
 * it finds the opening parenthesis of the call, matches it with its closing
 * parenthesis, and then walks back over the callee to get the start of the
 * call expression.
 */
const parseCallExpression = (code: string, offset: number): [number, string] | undefined => {
  const open = findOpeningParen(code, offset);
  if (open === -1) return undefined;
  const close = matchParen(code, open);
  if (close === -1) return undefined;
  const begin = findCallStart(code, open);
  if (begin === -1) return undefined;
  const text = code.slice(begin, close + 1).replace(escapeSequencesRegExp, escapeFn);
  return [begin, text];
};

/**
 * The opening parenthesis of the call expression at or after `offset`.
 *
 * A parenthesis that follows an identifier, `)` or `]` opens a call; one
 * that follows `=>`, `,` or `=` opens a parameter list or an arrow body and
 * is skipped.
 */
const findOpeningParen = (code: string, offset: number): number => {
  let inString: string | undefined;
  for (let i = offset; i < code.length; i += 1) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch !== "(") continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j -= 1;
    if (j < 0) continue;
    const prev = code[j];
    if (/[\w$]/.test(prev) || prev === ")" || prev === "]") return i;
  }
  return -1;
};

/** Index of the `)` matching the `(` at `open`, or -1. */
const matchParen = (code: string, open: number): number => {
  let depth = 0;
  let inString: string | undefined;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** True when every `(` in `slice` is closed (ignoring strings/comments). */
const balancedCall = (slice: string): boolean => {
  let depth = 0;
  let inString: string | undefined;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === inString) inString = undefined;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
    } else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth === 0 && inString === undefined;
};

/** Scan back from the closing paren to the start of the call expression. */
/**
 * Walk back from the `(` at `open` to the start of the call expression.
 *
 * Node parses the source with acorn and reports the first token that yields
 * a valid call expression. For `assert.ok(...)` that is `assert` (the whole
 * member expression), but when the object is not part of the analysed slice
 * (Node reads the source starting at the call site's line, so a callee split
 * over two lines loses its object) the expression starts at the property:
 * `ok(...)`.
 */
const findCallStart = (code: string, open: number): number => {
  let j = open - 1;
  while (j >= 0 && /\s/.test(code[j])) j -= 1;
  if (j >= 0 && code[j] === ")") {
    // The callee is itself a call — walk back over its opening paren.
    const innerOpen = findMatchingOpen(code, j);
    if (innerOpen === -1) return -1;
    return findCallStart(code, innerOpen);
  }
  const nameStart = skipPropertyName(code, j);
  j = nameStart - 1;
  // Walk back over the whole member chain (`assert.ok.call` → `assert`).
  let chainStart = nameStart;
  for (;;) {
    let k = chainStart - 1;
    while (k >= 0 && /\s/.test(code[k])) k -= 1;
    if (k >= 0 && code[k] === ".") {
      k -= 1;
      while (k >= 0 && /\s/.test(code[k])) k -= 1;
      const objectEnd = k;
      while (k >= 0 && /[\w$]/.test(code[k])) k -= 1;
      if (k + 1 < objectEnd) {
        chainStart = k + 1;
        continue;
      }
      // No object in the slice — the expression starts at the property.
      break;
    }
    if (k >= 0 && code[k] === "]") {
      const objectStart = computedObjectStart(code, k);
      if (objectStart === -1) break;
      chainStart = objectStart;
      continue;
    }
    break;
  }
  return chainStart;
};

/**
 * The start of the expression that owns the `]` at `close` — the object of a
 * computed member access.
 */
const computedObjectStart = (code: string, close: number): number => {
  const bracketOpen = findMatchingBracket(code, close);
  if (bracketOpen === -1) return -1;
  let j = bracketOpen - 1;
  while (j >= 0 && /\s/.test(code[j])) j -= 1;
  if (j >= 0 && code[j] === "]") {
    return computedObjectStart(code, j);
  }
  if (j >= 0 && code[j] === ")") {
    const parenOpen = findMatchingOpen(code, j);
    if (parenOpen === -1) return -1;
    return computedObjectStart(code, parenOpen - 1);
  }
  while (j >= 0 && /[\w$]/.test(code[j])) j -= 1;
  return j + 1;
};

/** Index of the `[` matching the `]` at `close`, or -1. */
const findMatchingBracket = (code: string, close: number): number => {
  let depth = 0;
  let inString: string | undefined;
  for (let i = close; i >= 0; i -= 1) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i -= 1;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "]") depth += 1;
    else if (ch === "[") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * Skip over a property name ending at `end`: an identifier, a quoted string
 * or a bracketed expression. Returns the index where the property starts.
 */
const skipPropertyName = (code: string, end: number): number => {
  let j = end;
  while (j >= 0 && /\s/.test(code[j])) j -= 1;
  if (j >= 0 && code[j] === "]") {
    const open = findMatchingBracket(code, j);
    return open === -1 ? j + 1 : open;
  }
  if (j >= 0 && (code[j] === "'" || code[j] === '"' || code[j] === "`")) {
    const quote = code[j];
    let k = j - 1;
    while (k >= 0 && code[k] !== quote) k -= 1;
    return k === -1 ? j + 1 : k;
  }
  while (j >= 0 && /[\w$]/.test(code[j])) j -= 1;
  return j + 1;
};

/** Index of the `(` matching the `)` at `close`, or -1. */
const findMatchingOpen = (code: string, close: number): number => {
  let depth = 0;
  let inString: string | undefined;
  for (let i = close; i >= 0; i -= 1) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i -= 1;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === ")") depth += 1;
    else if (ch === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * Node's `getErrMessage` (lib/assert.js): derive the "falsy expression"
 * message from the call site.
 *
 * Returns `undefined` when the expression cannot be recovered (the source is
 * not readable, e.g. `new Function(...)`); Node then lets the
 * AssertionError render the generic operator message (`false == true`).
 */
export const getErrMessage = (
  message: string | undefined,
  fn: (...args: never[]) => unknown,
): string | undefined => {
  if (message) return message;

  const limit = Error.stackTraceLimit;
  const err = {} as { stack?: unknown };
  try {
    Error.stackTraceLimit = 10;
  } catch {
    // Some engines do not allow writing to stackTraceLimit; ignore.
  }
  Error.captureStackTrace?.(err);

  let call: CallSite | undefined;
  try {
    const stack = err.stack as unknown as CallSite[] | string | undefined;
    if (typeof stack === "string") {
      // Skip the frames that belong to the shim itself; the first frame
      // outside it is the `assert.ok(...)` call site the user wrote.
      call = parseFirstFrame(stack, ({ filename, text }) => {
        // Native / internal frames have no useful file.
        if (filename.startsWith("node:")) return false;
        // The shim's own frames (ok → innerOk → getErrMessage, all inside
        // the bundled shim file or its TS sources).
        if (filename.includes("node-web-shims")) return false;
        // Module-internal loaders.
        if (filename.includes("internal/modules") || filename.includes("node:internal"))
          return false;
        // `Error.captureStackTrace` itself.
        if (text.startsWith("Error.captureStackTrace")) return false;
        return true;
      });
    } else {
      call = stack?.[0] as CallSite | undefined;
    }
    if (!call || typeof call.getFileName !== "function") return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      Error.stackTraceLimit = limit;
    } catch {
      // ignore
    }
  }

  const filename = call.getFileName();
  const line = call.getLineNumber() - 1;
  const column = call.getColumnNumber() - 1;
  if (process.env.BOLO_DEBUG_OK_EXPRESSION) {
    process.stdout.write(`ok-expr: file=${filename} line=${line} col=${column}\n`);
  }

  if (!filename) return undefined;

  const identifier = `${filename}${line}${column}`;
  if (errorCache.has(identifier)) {
    return errorCache.get(identifier);
  }

  try {
    const reader = readSource ?? globalReader();
    if (!reader) {
      errorCache.set(identifier, undefined);
      return undefined;
    }
    const source = reader(filename);
    if (source === undefined) {
      errorCache.set(identifier, undefined);
      return undefined;
    }

    // Extract the source of the call line and following lines.
    const lines = source.split("\n");
    let code = lines.slice(line).join("\n");
    const parsed = parseCallExpression(code, column);
    if (!parsed) {
      errorCache.set(identifier, undefined);
      return undefined;
    }
    let text = parsed[1];
    if (text.includes("\n")) {
      // Node normalises the indentation: the first line keeps its position,
      // every following line loses the base indentation of the call site and
      // is re-indented by two spaces.
      const frames = text.split("\n");
      const first = frames.shift() as string;
      // The base indentation is the leading whitespace of the source line the
      // call starts on.
      const sourceLine = lines[line] ?? "";
      let baseIndent = 0;
      while (
        baseIndent < sourceLine.length &&
        (sourceLine[baseIndent] === " " || sourceLine[baseIndent] === "\t")
      ) {
        baseIndent += 1;
      }
      let rebuilt = first;
      for (const frame of frames) {
        let pos = 0;
        while (pos < baseIndent && (frame[pos] === " " || frame[pos] === "\t")) pos += 1;
        rebuilt += `\n  ${frame.slice(pos)}`;
      }
      text = rebuilt;
    }
    const result = `The expression evaluated to a falsy value:\n\n  ${text}\n`;
    errorCache.set(identifier, result);
    return result;
  } catch {
    errorCache.set(identifier, undefined);
    return undefined;
  }
};
