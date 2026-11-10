import { describe, it, expect } from "vitest";
// @ts-expect-error plain-JS module, no type declarations
import { toNodeCompatReport } from "../../apps/compat-harness/bin/node-compat-report.js";

const modules = [
  {
    module: "path",
    results: [
      {
        file: "test/parallel/test-path-basename.js",
        status: "pass",
        exitCode: 0,
        output: "ok",
      },
      {
        file: "test/parallel/test-path-dirname.js",
        status: "fail",
        exitCode: 1,
        output: "\nUncaught AssertionError: 'a' strictEqual 'b'\n    at <stack>",
      },
    ],
  },
  {
    module: "buffer",
    results: [
      {
        file: "test/parallel/test-buffer-fill.js",
        status: "skip",
        exitCode: 0,
        output: "1..0 # SKIP no crypto",
      },
      {
        file: "test/parallel/test-buffer-concat.js",
        status: "fail",
        exitCode: 1,
        output: "",
      },
    ],
  },
];

describe("toNodeCompatReport", () => {
  const report = toNodeCompatReport(modules, {
    nodeVersion: "22.0.0",
    generatedAt: "2026-11-08T00:00:00Z",
  });

  it("emits the site-consumable shape", () => {
    expect(report.nodeVersion).toBe("22.0.0");
    expect(report.generatedAt).toBe("2026-11-08T00:00:00Z");
    expect(report.validated).toBe(true);
    expect(report.total).toBe(4);
    expect(report.pass).toBe(1);
    expect(report.fail).toBe(2);
    expect(report.skip).toBe(1);
  });

  it("per-module entries carry name/passed/total/tests", () => {
    const [path, buffer] = report.modules;
    expect(path).toMatchObject({ name: "path", passed: 1, total: 2 });
    expect(buffer).toMatchObject({ name: "buffer", passed: 0, total: 2 });
  });

  it("tests use basenames and non-pass entries get a one-line error", () => {
    const [path, buffer] = report.modules;
    expect(path.tests[0]).toEqual({ file: "test-path-basename.js", status: "pass" });
    expect(path.tests[1].file).toBe("test-path-dirname.js");
    expect(path.tests[1].error).toBe("Uncaught AssertionError: 'a' strictEqual 'b'");
    expect(buffer.tests[0]).toEqual({
      file: "test-buffer-fill.js",
      status: "skip",
      error: "skipped",
    });
    expect(buffer.tests[1].error).toBe("exit code 1");
  });

  it("skips data: URL location lines from container crashes", () => {
    const report = toNodeCompatReport(
      [
        {
          module: "m",
          results: [
            {
              file: "test/parallel/test-x.js",
              status: "fail",
              exitCode: 1,
              output: `data:text/javascript,${"x".repeat(1000)}:3:1\nUncaught TypeError: boom\nNode.js v22.0.0`,
            },
          ],
        },
      ],
      { nodeVersion: "22.0.0" },
    );
    expect(report.modules[0].tests[0].error).toBe("Uncaught TypeError: boom");
  });
});
