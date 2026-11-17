// Adversarial probe of the compat harness: does exit code reflect real failures?
// Usage: node probe.mjs <harnessUrl> <repoRoot>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const [url, repo] = process.argv.slice(2);
const require = createRequire(`${repo}/apps/compat-harness/package.json`);
const { chromium } = require("playwright-core");
const matrix = JSON.parse(readFileSync(`${repo}/apps/compat-harness/src/package-matrix.json`, "utf8"));

const ident = (n) => {
  const s = n.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[a-zA-Z_$]/.test(s) ? s : `_${s}`;
};
const buildProbe = (p) =>
  p.source ??
  `${p.import !== false ? `import ${ident(p.name)} from 'https://esm.sh/${p.name}';` : ""}
try {
  ${p.probe};
  console.log('PASS');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
`;

// Each case should FAIL (nonzero exit) under real Node.
const adversarial = {
  "exit-1": "process.exit(1);",
  "exit-1-then-log": "process.exit(1); console.log('after exit');",
  "throw-in-timeout": "setTimeout(() => { throw new Error('boom'); }, 10);",
  "unhandled-rejection": "Promise.reject(new Error('nope'));",
  "async-assert": "import assert from 'node:assert'; setTimeout(() => assert.strictEqual(1, 2), 10);",
  "top-level-throw": "throw new Error('sync boom');",
  "exitCode-2": "process.exitCode = 2;",
  "mustCall-never-called":
    "const common = require('/home/harness/test/common/index.js'); common.mustCall(() => {});",
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e.message).slice(0, 200)));
await page.goto(url);
try { await page.waitForFunction(() => window.__compatHarness, null, { timeout: 60000 }); } catch (e) { console.log('LOAD FAIL', consoleErrors); throw e; }
await page.evaluate(() => window.__compatHarness.boot());

const run = (path, source) =>
  page.evaluate(
    async ([p, s]) => {
      const t = setTimeout(() => {}, 0);
      clearTimeout(t);
      const r = await Promise.race([
        window.__compatHarness.run(p, s),
        new Promise((res) => setTimeout(() => res({ exitCode: "TIMEOUT", output: "" }), 20000)),
      ]);
      // let async failures surface before we read state
      await new Promise((res) => setTimeout(res, 200));
      return r;
    },
    [path, source],
  );

const out = { adversarial: {}, matrix: [] };
await page.evaluate(async (src) => {
  await window.__compatHarness.write("/test/common/index.js", src);
}, "module.exports = { mustCall: (fn) => fn };");
for (const [name, src] of Object.entries(adversarial)) {
  const r = await run(`/adv/${name}.mjs`, src);
  out.adversarial[name] = { exitCode: r.exitCode, output: r.output.slice(0, 200) };
  console.log("ADV", name, "exit=", r.exitCode, JSON.stringify(r.output.slice(0, 80)));
}

for (const p of matrix.packages) {
  const r = await run(`/probe/${p.name.replace(/\//g, "_")}.mjs`, buildProbe(p));
  const printedPass = /\bPASS\b/.test(r.output);
  out.matrix.push({ name: p.name, exitCode: r.exitCode, printedPass, output: r.output.slice(0, 300) });
}
out.pageErrors = consoleErrors;
writeFileSync("/tmp/bolo-probe/result.json", JSON.stringify(out, null, 2));
const scoredPass = out.matrix.filter((m) => m.exitCode === 0);
const falsePass = scoredPass.filter((m) => !m.printedPass);
console.log(`matrix: ${out.matrix.length} total, ${scoredPass.length} scored pass, ${falsePass.length} scored pass without printing PASS`);
for (const f of falsePass) console.log("FALSE-PASS", f.name, JSON.stringify(f.output.slice(0, 120)));
await browser.close();
