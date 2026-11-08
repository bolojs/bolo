// Spike (a): do module/importScripts/fetch requests issued from a dedicated
// Worker pass through the page-registered ServiceWorker? Runs on chromium,
// firefox, webkit and prints a per-engine verdict table.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchEngine, observePage, engines, type EngineName } from "../lib/browsers.js";

const BASE = process.env.SPIKE_BASE ?? "http://localhost:5311";

// URLs we expect each worker to generate (marker query param w=...), mapped to
// the client type the SW should resolve for them. The two worker script URLs
// themselves are requested by the page, so client is "window".
const expected = [
  { w: "module", client: "window", kind: "worker script (module)" },
  { w: "static", client: "worker", kind: "static import in module worker" },
  { w: "dyn", client: "worker", kind: "dynamic import() in module worker" },
  { w: "modfetch", client: "worker", kind: "fetch() in module worker" },
  { w: "classic", client: "window", kind: "worker script (classic)" },
  { w: "imp", client: "worker", kind: "importScripts in classic worker" },
  { w: "cfetch", client: "worker", kind: "fetch() in classic worker" },
  { w: "cdyn", client: "worker", kind: "dynamic import() in classic worker" },
];

interface EngineResult {
  engine: EngineName;
  version: string;
  result: {
    controlled: boolean;
    moduleWorker: unknown;
    classicWorker: unknown;
    swLog: { url: string; dest: string; client: string | null }[];
    error: string | null;
  } | null;
  verdicts: { kind: string; w: string; intercepted: boolean | null; client: string | null }[];
  error?: string;
}

const runEngine = async (engine: EngineName): Promise<EngineResult> => {
  const browser = await launchEngine(engine);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    observePage(page, engine);
    const qs = process.env.SPIKE_NOSW ? "?nosw=1" : "";
    await page.goto(`${BASE}/a/index.html${qs}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => (window as any).__spikeResult, undefined, {
      timeout: 45000,
    });
    const result = (await page.evaluate(() => (window as any).__spikeResult)) as EngineResult["result"];
    const version = await browser.version();
    const verdicts = expected.map((e) => {
      const hit = result?.swLog.find((l) => l.url.includes(`w=${e.w}`));
      return {
        kind: e.kind,
        w: e.w,
        intercepted: hit ? true : result === null ? null : false,
        client: hit?.client ?? null,
      };
    });
    return { engine, version, result, verdicts };
  } catch (e) {
    return {
      engine,
      version: "?",
      result: null,
      verdicts: [],
      error: String(e),
    };
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
  if (r.result) {
    console.log(`  controlled=${r.result.controlled}`);
    console.log(`  moduleWorker=${JSON.stringify(r.result.moduleWorker)}`);
    console.log(`  classicWorker=${JSON.stringify(r.result.classicWorker)}`);
    for (const v of r.verdicts) {
      console.log(`  ${v.intercepted ? "SW" : "no-SW"} (${v.client ?? "-"}): ${v.kind}`);
    }
  }
}
console.log(`\nwrote ${out}`);
