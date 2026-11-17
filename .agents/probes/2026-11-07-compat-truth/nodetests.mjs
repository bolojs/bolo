import { createRequire } from "node:module";
const require = createRequire("/Users/josocjoq/Documents/prjcts/_own/bolo/apps/compat-harness/package.json");
const { chromium } = require("playwright-core");
const b = await chromium.launch({ executablePath: process.env.CHROME });
const p = await b.newPage();
await p.goto("http://localhost:5199");
await p.waitForFunction(() => window.__compatHarness, null, { timeout: 60000 });
const res = await Promise.race([p.evaluate(() => window.__runNodeTests()), new Promise(r => setTimeout(() => r(null), 600000))]);
if (!res) { console.log("TIMEOUT"); process.exit(1); }
let pass = 0, total = 0; const passOut = [];
for (const m of res) for (const t of m.results) { total++; if (t.status === "pass") { pass++; if (t.output.trim()) passOut.push(`${m.module}/${t.file.split('/').pop()}: ${t.output.trim().slice(0,90)}`); } }
console.log(`node tests: ${pass}/${total} pass`); console.log("passes with output:", passOut.length); passOut.slice(0,12).forEach(x=>console.log(" ", x));
await b.close();
