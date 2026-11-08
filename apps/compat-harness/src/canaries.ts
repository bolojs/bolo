import type { CompatHarness } from "./main.js";
import { canaryFailedAsExpected, leakedCanaryNames } from "./classify.js";

/**
 * Adversarial scripts that FAIL under real Node (non-zero exit). If the harness
 * scores any of them as exit 0, the scorer is lying and the whole run is
 * invalid. Origin: .agents/probes/2026-11-07-compat-truth/probe.mjs.
 */
export const canaries: Record<string, string> = {
  "exit-1": "process.exit(1);",
  "exit-1-then-log": "process.exit(1); console.log('after exit');",
  "throw-in-timeout": "setTimeout(() => { throw new Error('boom'); }, 10);",
  "unhandled-rejection": "Promise.reject(new Error('nope'));",
  "async-assert":
    "import assert from 'node:assert'; setTimeout(() => assert.strictEqual(1, 2), 10);",
  "top-level-throw": "throw new Error('sync boom');",
  "exitCode-2": "process.exitCode = 2;",
  "mustCall-never-called":
    "const common = require('../test/common/index.js'); common.mustCall(() => {});",
};

export interface CanaryResult {
  name: string;
  exitCode: number | "TIMEOUT";
  output: string;
  /** True when the runtime correctly failed the script (the desired outcome). */
  failedAsExpected: boolean;
}

export const CANARY_TIMEOUT_MS = 20_000;

export const runCanaries = async (harness: CompatHarness): Promise<CanaryResult[]> => {
  const results: CanaryResult[] = [];
  for (const [name, source] of Object.entries(canaries)) {
    const path = `/adv/${name}.${source.includes("import ") ? "mjs" : "js"}`;
    await harness.write(path, source);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      harness.exec(path),
      new Promise<{ exitCode: "TIMEOUT"; output: string }>((resolve) => {
        timer = setTimeout(() => resolve({ exitCode: "TIMEOUT", output: "" }), CANARY_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    results.push({
      name,
      exitCode: outcome.exitCode,
      output: outcome.output.slice(0, 200),
      failedAsExpected: canaryFailedAsExpected(outcome.exitCode),
    });
  }
  return results;
};

export const assertCanariesFail = (results: CanaryResult[]): void => {
  const leaked = leakedCanaryNames(results);
  if (leaked.length > 0) {
    throw new Error(`INVALID RUN: canaries scored as pass/hang: ${leaked.join(", ")}`);
  }
};
