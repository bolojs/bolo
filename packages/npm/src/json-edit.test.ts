import { describe, it, expect } from "vitest";
import { readPackageJsonWithMeta, writePackageJsonWithMeta } from "./json-edit.js";

describe("json-edit", () => {
  it("preserves 2-space indent", () => {
    const input = '{\n  "name": "a",\n  "dependencies": {}\n}';
    const { data, indent, trailingNewline } = readPackageJsonWithMeta(input);

    expect(writePackageJsonWithMeta(data, indent, trailingNewline)).toBe(input);
  });

  it("preserves tab indent", () => {
    const input = '{\n\t"name": "a",\n\t"dependencies": {}\n}';
    const { data, indent, trailingNewline } = readPackageJsonWithMeta(input);

    expect(writePackageJsonWithMeta(data, indent, trailingNewline)).toBe(input);
  });

  it("preserves key order", () => {
    const input = '{\n  "dependencies": {},\n  "devDependencies": {}\n}';
    const { data, indent, trailingNewline } = readPackageJsonWithMeta(input);

    expect(writePackageJsonWithMeta(data, indent, trailingNewline)).toBe(input);
  });

  it("adds trailing newline if originally present", () => {
    const withNewline = '{\n  "name": "a"\n}\n';
    const withoutNewline = '{\n  "name": "a"\n}';

    const meta1 = readPackageJsonWithMeta(withNewline);
    expect(writePackageJsonWithMeta(meta1.data, meta1.indent, meta1.trailingNewline)).toBe(
      withNewline,
    );

    const meta2 = readPackageJsonWithMeta(withoutNewline);
    expect(writePackageJsonWithMeta(meta2.data, meta2.indent, meta2.trailingNewline)).toBe(
      withoutNewline,
    );
  });
});
