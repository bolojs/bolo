import { describe, it, expect } from "vitest";
import {
  rewriteBareImports,
  rewriteNextImports,
  rewriteCssImports,
  cssImportModule,
} from "./compile.js";

describe("rewriteBareImports", () => {
  const importMap = {
    imports: {
      react: "https://esm.sh/react@19",
      "react/": "https://esm.sh/react@19/",
      "next/head": "/shims/next/head.js",
    },
  };

  it("resolves exact and prefix mappings", () => {
    const code = 'import { jsx } from "react/jsx-runtime";\nimport React from "react";';
    const out = rewriteBareImports(code, importMap);
    expect(out).toContain('from "https://esm.sh/react@19/jsx-runtime"');
    expect(out).toContain('from "https://esm.sh/react@19"');
  });

  it("leaves relative, absolute, URL, and data: specifiers alone", () => {
    const code = [
      'import a from "./relative";',
      'import b from "/absolute";',
      'import c from "https://example.com/x.js";',
      'import d from "data:text/javascript,export default 1";',
      'import e from "node:fs";',
    ].join("\n");
    expect(rewriteBareImports(code, importMap)).toBe(code);
  });

  it("leaves unmapped specifiers alone", () => {
    const code = 'import x from "some-unmapped-pkg";';
    expect(rewriteBareImports(code, importMap)).toBe(code);
  });

  it("handles import() dynamic forms", () => {
    const code = 'const m = await import("react");';
    const out = rewriteBareImports(code, importMap);
    expect(out).toBe('const m = await import("https://esm.sh/react@19");');
  });
});

describe("rewriteNextImports", () => {
  it("maps next/* specifiers to the shim base", () => {
    const code = 'import Head from "next/head";\nimport Link from "next/link";';
    const out = rewriteNextImports(code, "/__next/_bolo/shims");
    expect(out).toContain('from "/__next/_bolo/shims/head.js"');
    expect(out).toContain('from "/__next/_bolo/shims/link.js"');
  });

  it("leaves other imports alone", () => {
    const code = 'import React from "react";';
    expect(rewriteNextImports(code, "/shims")).toBe(code);
  });
});

describe("rewriteCssImports", () => {
  it("appends ?import to relative and absolute css imports", () => {
    const code = 'import "../styles/globals.css";\nimport "/x.css";';
    const out = rewriteCssImports(code);
    expect(out).toContain('"../styles/globals.css?import"');
    expect(out).toContain('"/x.css?import"');
  });

  it("leaves non-css imports alone", () => {
    const code = 'import a from "./a.ts";\nimport b from "pkg/style";';
    expect(rewriteCssImports(code)).toBe(code);
  });
});

describe("cssImportModule", () => {
  it("wraps css in a style-injecting module", () => {
    const mod = cssImportModule("body { color: red; }");
    expect(mod).toContain("createElement('style')");
    expect(mod).toContain("export default css");
    expect(mod).toContain("body { color: red; }");
  });
});
