#!/usr/bin/env tsx
/**
 * Backpressure gate for the workspace: typecheck + lint + format + test.
 * Run via `pnpm validate`. Each step prints OK/FAIL; full output only on failure.
 * Covers every pnpm workspace (packages/, apps/, examples/, tests/) via turbo.
 * Same gate runs in CI and as a lefthook pre-push, so catching failures here
 * saves a round-trip. Bypass with `git push --no-verify`.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = process.env.LOG_DIR ?? "/tmp/brioso";

interface Step {
  title: string;
  args: string[];
}

const steps: Step[] = [
  { title: "typecheck", args: ["run", "typecheck"] },
  { title: "lint", args: ["run", "lint"] },
  { title: "format", args: ["run", "format"] },
  { title: "test", args: ["run", "test"] },
];

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "turbo", ...args], {
      cwd: process.cwd(),
      shell: false,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

let failed = false;

for (const step of steps) {
  const { code, output } = await run(step.args);
  if (code === 0) {
    console.log(`\x1b[32m✓\x1b[0m ${step.title}`);
  } else {
    failed = true;
    console.log(`\x1b[31m✗\x1b[0m ${step.title}`);

    await mkdir(LOG_DIR, { recursive: true });
    await writeFile(join(LOG_DIR, `${step.title}.log`), output.trim());
  }
}

process.exit(failed ? 1 : 0);
