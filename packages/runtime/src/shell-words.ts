/**
 * Shell-word splitting / quoting for the routed-builtin argv boundary.
 *
 * `route()` takes a raw command string but routed builtins (git, node, npm,
 * the wasm registry) take argv. Naively splitting on whitespace destroyed
 * quoting (`git commit -m "a b"` → `["-m", "\"a", "b\""]`), and the other
 * direction — `spawn(cmd, args)` re-joining argv into a command string —
 * lost arg boundaries whenever an arg contained whitespace.
 *
 * `splitShellArgs` and `quoteShellArg` are inverse: for any argv,
 * `splitShellArgs(argv.map(quoteShellArg).join(" "))` returns the original
 * argv. Splitting is intentionally lenient (an unmatched quote consumes to
 * end of input) — this is a dispatch boundary, not a parser; just-bash gets
 * the untouched raw string for anything that falls through.
 */

export const splitShellArgs = (input: string): string[] => {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      i++;
      continue;
    }
    hasToken = true;
    if (c === "'") {
      i++;
      while (i < n && input[i] !== "'") {
        current += input[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && input[i] !== '"') {
        if (
          input[i] === "\\" &&
          i + 1 < n &&
          (input[i + 1] === '"' ||
            input[i + 1] === "\\" ||
            input[i + 1] === "$" ||
            input[i + 1] === "`")
        ) {
          current += input[i + 1];
          i += 2;
        } else {
          current += input[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      current += input[i + 1];
      i += 2;
      continue;
    }
    current += c;
    i++;
  }
  if (hasToken) args.push(current);
  return args;
};

/**
 * Quote one argv element so a re-parse recovers it verbatim. Args without
 * special characters pass through untouched, so `["npm", "install"]` still
 * joins to `npm install`. `$`/backtick are escaped too — a joined command
 * may still fall through to just-bash, where they would otherwise expand.
 */
export const quoteShellArg = (arg: string): string => {
  if (arg !== "" && !/[\s"'\\$`]/.test(arg)) return arg;
  return `"${arg.replace(/["\\$`]/g, "\\$&")}"`;
};

export const joinShellArgs = (args: readonly string[]): string => args.map(quoteShellArg).join(" ");
