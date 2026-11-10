import { describe, it, expect } from "vitest";
import {
  bareSpecifierToInstall,
  buildProbeSource,
  classifyProbe,
  DEFAULT_PACKAGE_TIMEOUT_MS,
  esmShUrlToSpecifier,
  extractInstallSpecs,
  PackageMatrixRunner,
  rewriteEsmImports,
  tail,
  type PackageMatrix,
} from "../../apps/compat-harness/src/package-runner.ts";
import type { CompatHarness } from "../../apps/compat-harness/src/main.ts";

const createHarness = (
  options: {
    boot?: () => Promise<void>;
    install?: () => Promise<{ exitCode: number; output: string }>;
  } = {},
): CompatHarness => ({
  ready: false,
  boot: async () => {
    await options.boot?.();
  },
  write: async () => {},
  exec: async () => ({ exitCode: 0, output: "PASS\n" }),
  install: async () => (await options.install?.()) ?? { exitCode: 0, output: "" },
  run: async () => ({ exitCode: 0, output: "" }),
  teardown: async () => {},
});

const testMatrix: PackageMatrix = {
  version: "test",
  packages: [
    { name: "first", class: "test", bind: "import x from 'first'", probe: "x" },
    { name: "second", class: "test", bind: "import x from 'second'", probe: "x" },
  ],
};

describe("PackageMatrixRunner timeouts", () => {
  it("uses a 60 second per-package timeout by default", () => {
    expect(DEFAULT_PACKAGE_TIMEOUT_MS).toBe(60_000);
  });

  it("records a boot timeout and continues with the next package", async () => {
    let bootCalls = 0;
    const harness = createHarness({
      boot: async () => {
        bootCalls += 1;
        if (bootCalls === 1) await new Promise<void>(() => {});
      },
    });
    const runner = new PackageMatrixRunner({
      harness,
      matrix: testMatrix,
      packageTimeoutMs: 10,
    });

    const results = await runner.runAll();

    expect(results.map((result) => [result.status, result.error])).toEqual([
      ["fail", "TIMEOUT after 10ms"],
      ["pass", undefined],
    ]);
    expect(bootCalls).toBe(2);
  }, 1_000);

  it("records an install timeout and continues with the next package", async () => {
    let installCalls = 0;
    const harness = createHarness({
      install: async () => {
        installCalls += 1;
        if (installCalls === 1) return new Promise(() => {});
        return { exitCode: 0, output: "" };
      },
    });
    const runner = new PackageMatrixRunner({
      harness,
      matrix: testMatrix,
      packageTimeoutMs: 10,
    });

    const results = await runner.runAll();

    expect(results.map((result) => [result.status, result.error])).toEqual([
      ["fail", "TIMEOUT after 10ms"],
      ["pass", undefined],
    ]);
  });
});

describe("PackageMatrixRunner incremental progress", () => {
  it("calls onPackageStart before each package and onResult after it", async () => {
    const events: string[] = [];
    const harness = createHarness();
    const runner = new PackageMatrixRunner({
      harness,
      matrix: testMatrix,
      packageTimeoutMs: 10,
      onPackageStart: (name) => events.push(`start:${name}`),
      onResult: (result) => events.push(`result:${result.name}:${result.status}`),
    });

    await runner.runAll();

    expect(events).toEqual([
      "start:first",
      "result:first:pass",
      "start:second",
      "result:second:pass",
    ]);
  });

  it("reports timeout results through onResult as well", async () => {
    const results: { name: string; status: string }[] = [];
    const harness = createHarness({
      boot: async () => {
        await new Promise<void>(() => {});
      },
    });
    const runner = new PackageMatrixRunner({
      harness,
      matrix: testMatrix,
      packageTimeoutMs: 10,
      onResult: (r) => results.push({ name: r.name, status: r.status }),
    });

    await runner.runAll();

    expect(results).toEqual([
      { name: "first", status: "fail" },
      { name: "second", status: "fail" },
    ]);
  });

  it("skips the packages named in `skip` (resume support)", async () => {
    const harness = createHarness();
    const runner = new PackageMatrixRunner({
      harness,
      matrix: testMatrix,
      packageTimeoutMs: 10,
      skip: ["first"],
    });

    const results = await runner.runAll();

    expect(results.map((r) => r.name)).toEqual(["second"]);
  });
});

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

describe("tail", () => {
  it("returns short output verbatim", () => {
    expect(tail("some error\n")).toBe("some error");
  });

  it("elides the giant data: URL frame a container crash prints", () => {
    const url = `data:text/javascript,${"x".repeat(2000)}`;
    const output = `TypeError: boom\n    at ${url}:10:5\nNode.js v22.0.0`;
    const result = tail(output);
    expect(result).toContain("TypeError: boom");
    expect(result).toContain("chars elided");
    expect(result).toContain("Node.js v22.0.0");
    expect(result).not.toContain("x".repeat(500));
  });

  it("keeps both ends of long output so the head error survives", () => {
    const output = `Error: first\n${"filler\n".repeat(200)}last line`;
    const result = tail(output);
    expect(result.length).toBeLessThanOrEqual(520);
    expect(result).toContain("Error: first");
    expect(result).toContain("last line");
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
