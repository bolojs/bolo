import { describe, it, expect } from "vitest";
import {
  bareSpecifierToInstall,
  buildProbeSource,
  classifyProbe,
  esmShUrlToSpecifier,
  extractInstallSpecs,
  rewriteEsmImports,
} from "../../apps/compat-harness/src/package-runner.ts";

describe("esmShUrlToSpecifier", () => {
  it("strips the origin and keeps a plain package name", () => {
    expect(esmShUrlToSpecifier("lodash")).toEqual({
      specifier: "lodash",
      install: "lodash",
    });
  });

  it("keeps scoped names", () => {
    expect(esmShUrlToSpecifier("@swc/wasm-web")).toEqual({
      specifier: "@swc/wasm-web",
      install: "@swc/wasm-web",
    });
  });

  it("drops the version from the specifier but keeps it on the install spec", () => {
    expect(esmShUrlToSpecifier("lodash@4.17.21")).toEqual({
      specifier: "lodash",
      install: "lodash@4.17.21",
    });
    expect(esmShUrlToSpecifier("@scope/name@1.2.3")).toEqual({
      specifier: "@scope/name",
      install: "@scope/name@1.2.3",
    });
  });

  it("keeps subpaths on the specifier but not the install spec", () => {
    expect(esmShUrlToSpecifier("lodash@4/fp")).toEqual({
      specifier: "lodash/fp",
      install: "lodash@4",
    });
  });

  it("drops build prefixes and query params", () => {
    expect(esmShUrlToSpecifier("v135/react@18.2.0?bundle")).toEqual({
      specifier: "react",
      install: "react@18.2.0",
    });
    expect(esmShUrlToSpecifier("stable/preact")).toEqual({
      specifier: "preact",
      install: "preact",
    });
  });
});

describe("rewriteEsmImports", () => {
  it("rewrites esm.sh imports to bare specifiers", () => {
    const source =
      "import _ from 'https://esm.sh/lodash';\nimport { z } from \"https://esm.sh/zod\";";
    expect(rewriteEsmImports(source)).toBe("import _ from 'lodash';\nimport { z } from \"zod\";");
  });

  it("rewrites scoped and versioned specs and drops query params", () => {
    expect(rewriteEsmImports("import s from 'https://esm.sh/@swc/wasm-web';")).toBe(
      "import s from '@swc/wasm-web';",
    );
    expect(rewriteEsmImports("import l from 'https://esm.sh/lodash@4.17.21?bundle';")).toBe(
      "import l from 'lodash';",
    );
  });

  it("leaves bare and node: specifiers untouched", () => {
    const source = "import { EventEmitter } from 'node:events';\nimport _ from 'lodash';";
    expect(rewriteEsmImports(source)).toBe(source);
  });
});

describe("bareSpecifierToInstall", () => {
  it("keeps plain and scoped names", () => {
    expect(bareSpecifierToInstall("lodash")).toBe("lodash");
    expect(bareSpecifierToInstall("@babel/core")).toBe("@babel/core");
  });

  it("drops subpaths", () => {
    expect(bareSpecifierToInstall("lodash/fp")).toBe("lodash");
    expect(bareSpecifierToInstall("@swc/wasm-web/sub")).toBe("@swc/wasm-web");
  });

  it("rejects non-installable specifiers", () => {
    expect(bareSpecifierToInstall("node:events")).toBeUndefined();
    expect(bareSpecifierToInstall("./local.js")).toBeUndefined();
    expect(bareSpecifierToInstall("/abs/path.js")).toBeUndefined();
    expect(bareSpecifierToInstall("https://esm.sh/lodash")).toBeUndefined();
    expect(bareSpecifierToInstall("data:text/javascript,x")).toBeUndefined();
  });
});

describe("extractInstallSpecs", () => {
  it("collects unique bare specifiers from static imports", () => {
    const source = "import _ from 'lodash';\nimport { z } from 'zod';\nimport _ from 'lodash';";
    expect(extractInstallSpecs(source)).toEqual(["lodash", "zod"]);
  });

  it("collects side-effect and dynamic import specifiers", () => {
    const source = "import 'polyfill-x';\nconst m = await import('dep-y');";
    expect(extractInstallSpecs(source)).toEqual(["polyfill-x", "dep-y"]);
  });

  it("skips node: builtins and relative paths", () => {
    const source =
      "import { EventEmitter } from 'node:events';\nimport x from './x.js';\nimport _ from 'lodash';";
    expect(extractInstallSpecs(source)).toEqual(["lodash"]);
  });

  it("returns an empty list for builtin-only probes", () => {
    const source = "import { Buffer } from 'node:buffer';";
    expect(extractInstallSpecs(source)).toEqual([]);
  });
});

describe("buildProbeSource", () => {
  it("prepends the bind statement and requires a truthy probe result", () => {
    const out = buildProbeSource({
      name: "lodash",
      class: "Utility",
      bind: "import _ from 'lodash'",
      probe: "_.chunk(['a','b','c'], 2)",
    });
    expect(out).toContain("import _ from 'lodash'");
    expect(out).toContain("__result = await (_.chunk(['a','b','c'], 2));");
    expect(out).toContain("if (!__result)");
    expect(out).toContain("console.log('PASS')");
  });

  it("emits no import line when import is false", () => {
    const out = buildProbeSource({
      name: "fetch",
      class: "HTTP client",
      import: false,
      probe: "typeof fetch === 'function'",
    });
    expect(out).not.toContain("import ");
    expect(out).toContain("await (typeof fetch === 'function')");
  });

  it("falls back to a generated default import when no bind is given", () => {
    const out = buildProbeSource({
      name: "fast-json-stringify",
      class: "Validation",
      probe: "fast_json_stringify({})",
    });
    expect(out).toContain("import fast_json_stringify from 'fast-json-stringify';");
  });

  it("uses source verbatim but rewrites esm.sh imports", () => {
    const out = buildProbeSource({
      name: "swc",
      class: "Build tool",
      source: "import swc from 'https://esm.sh/@swc/wasm-web';\nconsole.log('PASS');",
    });
    expect(out).toContain("import swc from '@swc/wasm-web';");
    expect(out).not.toContain("esm.sh");
  });
});

describe("classifyProbe", () => {
  it("passes only on exit 0 with an explicit PASS marker", () => {
    expect(classifyProbe(0, "PASS\n")).toBe("pass");
    expect(classifyProbe(0, "some log\nPASS\n")).toBe("pass");
  });

  it("fails exit 0 without the PASS marker", () => {
    expect(classifyProbe(0, "no output at all")).toBe("fail");
    expect(classifyProbe(0, "false")).toBe("fail");
  });

  it("does not accept PASS embedded in other text", () => {
    expect(classifyProbe(0, "the PASS marker")).toBe("fail");
    expect(classifyProbe(0, "PASSWORD")).toBe("fail");
  });

  it("fails non-zero exits even with PASS in output", () => {
    expect(classifyProbe(1, "PASS\nboom")).toBe("fail");
  });

  it("classifies TAP-style skips", () => {
    expect(classifyProbe(0, "1..0 # SKIP not supported")).toBe("skip");
    expect(classifyProbe(1, "# skip: missing feature")).toBe("skip");
  });
});
