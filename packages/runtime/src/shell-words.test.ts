import { describe, it, expect } from "vitest";
import { joinShellArgs, quoteShellArg, splitShellArgs } from "./shell-words.js";

describe("splitShellArgs", () => {
  it("splits on whitespace like the old route() did", () => {
    expect(splitShellArgs("npm install lodash express")).toEqual([
      "npm",
      "install",
      "lodash",
      "express",
    ]);
  });

  it("keeps double-quoted runs as one arg", () => {
    expect(splitShellArgs('git commit -m "a b c"')).toEqual(["git", "commit", "-m", "a b c"]);
  });

  it("keeps single-quoted runs as one arg", () => {
    expect(splitShellArgs("node -e 'console.log(1 + 1)'")).toEqual([
      "node",
      "-e",
      "console.log(1 + 1)",
    ]);
  });

  it("unescapes quotes inside double quotes", () => {
    expect(splitShellArgs('node -e "console.log(\\"a b\\")"')).toEqual([
      "node",
      "-e",
      'console.log("a b")',
    ]);
  });

  it("preserves an empty quoted arg", () => {
    expect(splitShellArgs('node -e ""')).toEqual(["node", "-e", ""]);
  });
});

describe("quoteShellArg", () => {
  it("leaves plain args untouched", () => {
    expect(quoteShellArg("install")).toBe("install");
  });

  it("quotes args containing whitespace or shell metacharacters", () => {
    expect(quoteShellArg("a b c")).toBe('"a b c"');
    expect(quoteShellArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteShellArg("")).toBe('""');
  });

  it("round-trips through splitShellArgs", () => {
    const argv = ["git", "commit", "-m", "a b c", "it's", 'x"y', "$HOME", "a`b", ""];
    expect(splitShellArgs(joinShellArgs(argv))).toEqual(argv);
  });
});
