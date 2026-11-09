/**
 * Replays committed regression programs (tests/differential/regressions/*.js) in bolo and
 * compares against the expected markers and exit code recorded from real Node
 * (<name>.expected.json). Usage:
 *   tsx tests/differential/regressions.ts --url http://localhost:5174
 * Exit 1 if any program diverges on all 3 attempts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { markerLines } from "./process-programs.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const url = arg("url", "http://localhost:5173");
const dir = join(dirname(fileURLToPath(import.meta.url)), "regressions");

const main = async () => {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.slice(0, -3))
    .sort();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { timeout: 120_000 });
  await page.waitForFunction(() => typeof (window as any).__compatHarness !== "undefined");
  await page.evaluate(() => (window as any).__compatHarness.boot());
  const failures: string[] = [];
  for (const name of names) {
    const source = readFileSync(join(dir, `${name}.js`), "utf8");
    const expected = JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")) as {
      code: number;
      markers: string[];
    };
    let ok = false;
    let last = "";
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const got = await page.evaluate(
        async ({ path, source }) => {
          const h = (window as any).__compatHarness;
          await h.write(path, source);
          return (await Promise.race([
            h.exec(path),
            new Promise((r) => setTimeout(() => r({ exitCode: -999, output: "" }), 15_000)),
          ])) as { exitCode: number; output: string };
        },
        { path: `/regress/${name}-${attempt}.js`, source },
      );
      const markers = markerLines(got.output);
      ok = got.exitCode === expected.code && JSON.stringify(markers) === JSON.stringify(expected.markers);
      last = `code ${got.exitCode} (want ${expected.code})\n  want ${expected.markers.join(",")}\n  got  ${markers.join(",")}`;
    }
    if (!ok) {
      failures.push(name);
      console.log(`FAIL ${name}: ${last}`);
    }
  }
  await browser.close();
  console.log(JSON.stringify({ total: names.length, failed: failures.length }));
  process.exit(failures.length ? 1 : 0);
};
void main();
