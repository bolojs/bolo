import { describe, expect, it } from "vitest";
import { extractInstallSpecs } from "./package-runner.js";

describe("extractInstallSpecs", () => {
  it("extracts bare specifiers from import statements", () => {
    const source = `import bcrypt from 'bcrypt';\nimport * as ns from '@scope/pkg/sub';\n`;
    // Only the root package is installable — a subpath belongs to it.
    expect(extractInstallSpecs(source)).toEqual(["bcrypt", "@scope/pkg"]);
  });

  it("ignores member-call from() arguments such as Buffer.from", () => {
    const source = `import lightningcss from 'lightningcss';\nconst buf = Buffer.from('a { color: red; }');\n`;
    expect(extractInstallSpecs(source)).toEqual(["lightningcss"]);
  });
});
