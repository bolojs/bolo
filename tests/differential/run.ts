/**
 * Differential runner: Node is the oracle, bolo (compat-harness page in
 * Chromium) is the subject. Usage:
 *   tsx tests/differential/run.ts --url http://localhost:5173 --count 200 --seed 1 [--out file.json]
 * Divergent programs are written to the out file; exit 1 if any diverge.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { chromium } from "playwright-core";
import { markerLines, programArb, renderProgram } from "./process-programs.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const url = arg("url", "http://localhost:5173");
const count = Number(arg("count", "200"));
const seed = Number(arg("seed", "20261109"));
const out = arg("out", "");

const node = (source: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "bolo-diff-")), "p.js");
  writeFileSync(file, source);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 10_000 });
  return { code: r.status ?? -1, markers: markerLines(r.stdout) };
};

/**
 * BOLO-DIV-005: some programs race inside Node itself (equal-deadline timers across a
 * millisecond boundary). When bolo disagrees with the first oracle run, run Node more
 * times; if bolo matches any outcome Node produces, the program is oracle-unstable,
 * not a bolo divergence.
 */
const nodeOutcomes = (source: string, runs: number) => {
  const outcomes = new Set<string>();
  for (let i = 0; i < runs; i++) {
    const o = node(source);
    outcomes.add(JSON.stringify({ code: o.code, markers: o.markers }));
  }
  return outcomes;
};

const main = async () => {
  const programs = fc.sample(programArb, { numRuns: count, seed });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { timeout: 120_000 });
  await page.waitForFunction(() => typeof (window as any).__compatHarness !== "undefined");
  await page.evaluate(() => (window as any).__compatHarness.boot());

  const divergences: unknown[] = [];
  let unstable = 0;
  for (const [i, program] of programs.entries()) {
    const source = renderProgram(program);
    const oracle = node(source);
    const runBolo = (attempt: number) =>
      page.evaluate(
      async ({ path, source }) => {
        const h = (window as any).__compatHarness;
        await h.write(path, source);
        const race = await Promise.race([
          h.exec(path),
          new Promise((r) => setTimeout(() => r({ exitCode: -999, output: "" }), 15_000)),
        ]);
        return race as { exitCode: number; output: string };
      },
      { path: `/diff/p${i}-${attempt}.js`, source },
    );
    // Timer races exist in Node too: only count a program as divergent when it
    // diverges on every one of 3 attempts.
    let got = await runBolo(0);
    let markers = markerLines(got.output);
    const matches = () =>
      got.exitCode === oracle.code && JSON.stringify(markers) === JSON.stringify(oracle.markers);
    for (let attempt = 1; attempt < 3 && !matches(); attempt++) {
      got = await runBolo(attempt);
      markers = markerLines(got.output);
    }
    let same = matches();
    let oracleUnstable = false;
    if (!same) {
      const seen = nodeOutcomes(source, 8);
      if (seen.has(JSON.stringify({ code: got.exitCode, markers }))) {
        same = true;
        oracleUnstable = true;
      }
    }
    if (oracleUnstable) unstable++;
    if (!same) {
      divergences.push({ i, source, oracle, bolo: { code: got.exitCode, markers, output: got.output.slice(0, 500) } });
    }
  }
  await browser.close();
  const summary = { seed, count, agree: count - divergences.length, divergent: divergences.length, oracleUnstable: unstable };
  console.log(JSON.stringify(summary));
  if (out) writeFileSync(out, JSON.stringify({ summary, divergences }, null, 2));
  process.exit(divergences.length ? 1 : 0);
};
void main();
