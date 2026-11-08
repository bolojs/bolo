// Spike (c): Document-Isolation-Policy embed demo. Opens the DIP-served page
// on 127.0.0.1 (embedding a cross-site localhost iframe) in each engine and
// records crossOriginIsolated / SharedArrayBuffer availability, plus a
// COOP+COEP control page.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchEngine, observePage, engines, type EngineName } from "../lib/browsers.js";

const HOST_A = process.env.SPIKE_HOST_A ?? "http://127.0.0.1:5311";

interface EngineResult {
  engine: EngineName;
  version: string;
  dip: Record<string, unknown> | null;
  hosted: Record<string, unknown> | null;
  coopCoep: Record<string, unknown> | null;
  error?: string;
}

const runEngine = async (engine: EngineName): Promise<EngineResult> => {
  const browser = await launchEngine(engine);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    observePage(page, engine);
    await page.goto(`${HOST_A}/c/embed.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => (window as any).__spikeResult, undefined, {
      timeout: 15000,
    });
    const dip = (await page.evaluate(() => (window as any).__spikeResult)) as Record<string, unknown>;

    // Real embed scenario: plain host page (no headers) on 127.0.0.1 embeds
    // the DIP document cross-site via iframe.
    const pageH = await ctx.newPage();
    observePage(pageH, engine + "-host");
    await pageH.goto(`${HOST_A}/c/host.html`, { waitUntil: "load", timeout: 30000 });
    await pageH.waitForFunction(() => (window as any).__spikeResult, undefined, {
      timeout: 20000,
    });
    const hosted = (await pageH.evaluate(() => (window as any).__spikeResult)) as Record<
      string,
      unknown
    >;

    const page2 = await ctx.newPage();
    observePage(page2, engine + "-ctl");
    await page2.goto(`${HOST_A}/c/embed-coop-coep.html`, { waitUntil: "load", timeout: 30000 });
    await page2.waitForFunction(() => (window as any).__spikeResult, undefined, { timeout: 10000 });
    const coopCoep = (await page2.evaluate(() => (window as any).__spikeResult)) as Record<
      string,
      unknown
    >;
    return { engine, version: await browser.version(), dip, hosted, coopCoep };
  } catch (e) {
    return { engine, version: "?", dip: null, hosted: null, coopCoep: null, error: String(e) };
  } finally {
    await browser.close();
  }
};

const only = process.argv[2] ? ([process.argv[2]] as EngineName[]) : engines;
const results: EngineResult[] = [];
for (const engine of only) {
  console.log(`\n=== ${engine} ===`);
  results.push(await runEngine(engine));
}

const out = fileURLToPath(new URL("./results.json", import.meta.url));
await writeFile(out, JSON.stringify(results, null, 2));

console.log("\n===== SUMMARY =====");
for (const r of results) {
  console.log(`\n[${r.engine}] version=${r.version}`);
  if (r.error) console.log(`  runner error: ${r.error}`);
  console.log(`  DIP page:      ${JSON.stringify(r.dip)}`);
  console.log(`  hosted iframe: ${JSON.stringify(r.hosted)}`);
  console.log(`  COOP+COEP ctl: ${JSON.stringify(r.coopCoep)}`);
}
console.log(`\nwrote ${out}`);
