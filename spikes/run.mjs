// Repro runner: `node spikes/run.mjs <d|e> [chromium|firefox|webkit|all]`
// Launches playwright-core browsers (installed revisions match 1.61.1),
// opens the spike page, waits for window.__result, prints JSON.
import { chromium, firefox, webkit } from "playwright-core";

const spike = process.argv[2];
const which = process.argv[3] ?? "chromium";
const coi = process.env.COI === "1" ? 1 : 0;
const port = coi ? 5321 : 5322;
const page =
  spike === "d" ? "/d-rolldown-worker/index.html" : "/e-napi-threadless/index.html";

const PW = process.env.PW_BROWSERS ?? "/tmp/pw-browsers-r0-de";
const CHROME =
  process.env.CHROME ??
  `${PW}/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const engines = {
  chromium: () =>
    chromium.launch({ executablePath: CHROME }),
  firefox: () =>
    firefox.launch({ executablePath: `${PW}/firefox-1532/firefox/Nightly.app/Contents/MacOS/firefox` }),
  webkit: () =>
    webkit.launch({ executablePath: `${PW}/webkit-2311/pw_run.sh` }),
};

const targets = which === "all" ? Object.keys(engines) : [which];
const out = {};
for (const name of targets) {
  const browser = await engines[name]();
  const consoleErrors = [];
  try {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    pg.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
    });
    pg.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
    await pg.goto(`http://localhost:${port}${page}`, { waitUntil: "load" });
    const result = await pg.waitForFunction(() => globalThis.__result, null, {
      timeout: 120_000,
    });
    const value = await result.jsonValue();
    if (name === "chromium") {
      try {
        const cdp = await ctx.newCDPSession(pg);
        await cdp.send("Performance.enable");
        const { metrics } = await cdp.send("Performance.getMetrics");
        const heap = metrics.find((m) => m.name === "JSHeapUsedSize");
        const docs = metrics.find((m) => m.name === "Documents");
        const workers = metrics.find((m) => m.name === "Workers");
        value.rendererJSHeapMB = heap
          ? Math.round((heap.value / 1024 / 1024) * 10) / 10
          : null;
        value.rendererCounts = { Documents: docs?.value, Workers: workers?.value };
      } catch (e) {
        value.rendererMetricsError = String(e).slice(0, 200);
      }
    }
    out[name] = { ...value, consoleErrors };
  } catch (error) {
    out[name] = {
      verdict: "FAIL",
      runnerError: String(error).slice(0, 300),
      consoleErrors,
    };
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify({ coi: Boolean(coi), port, results: out }, null, 2));
