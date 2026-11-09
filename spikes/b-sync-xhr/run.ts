// Spike (b): latency of a synchronous-XHR channel from a worker to a
// ServiceWorker-served endpoint answered by main-thread state, without SAB.
// 1000 calls at 16B and 64KB; reports p50/p95/p99. Threshold: p95 < 5ms.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchEngine, observePage, engines, type EngineName } from "../lib/browsers.js";

const BASE = process.env.SPIKE_BASE ?? "http://localhost:5311";
const THRESHOLD_MS = 5;

interface EngineResult {
  engine: EngineName;
  version: string;
  result: {
    controlled: boolean;
    worker: {
      status: string;
      error?: string;
      report?: {
        probe?: { ms: number; prefix: string; status: number };
        aborted?: boolean;
        sizes?: Record<
          string,
          { n: number; p50: number; p95: number; p99: number; min: number; max: number; mean: number }
        >;
        prefixes?: Record<string, Record<string, number>>;
        error?: string;
      };
    } | null;
    error: string | null;
  } | null;
  error?: string;
}

const runEngine = async (engine: EngineName): Promise<EngineResult> => {
  const browser = await launchEngine(engine);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    observePage(page, engine);
    await page.goto(`${BASE}/b/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => (window as any).__spikeResult, undefined, {
      timeout: 300000,
    });
    const result = (await page.evaluate(() => (window as any).__spikeResult)) as EngineResult["result"];
    return { engine, version: await browser.version(), result };
  } catch (e) {
    return { engine, version: "?", result: null, error: String(e) };
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

const fmt = (n?: number) => (n === undefined ? "-" : n.toFixed(3) + "ms");
console.log("\n===== SUMMARY =====");
for (const r of results) {
  console.log(`\n[${r.engine}] version=${r.version}`);
  if (r.error) console.log(`  runner error: ${r.error}`);
  const rep = r.result?.worker?.report;
  if (rep?.probe) {
    console.log(
      `  probe: ${fmt(rep.probe.ms)} prefix=${rep.probe.prefix} status=${rep.probe.status}` +
        (rep.aborted ? " ABORTED" : ""),
    );
  }
  if (r.result?.worker?.status && r.result.worker.status !== "done") {
    console.log(`  worker status=${r.result.worker.status} ${r.result.worker.error ?? ""}`);
  }
  for (const [size, s] of Object.entries(rep?.sizes ?? {})) {
    const verdict = s.p95 < THRESHOLD_MS ? "PASS" : "FAIL";
    console.log(
      `  ${size}B: p50=${fmt(s.p50)} p95=${fmt(s.p95)} p99=${fmt(s.p99)} ` +
        `min=${fmt(s.min)} max=${fmt(s.max)} mean=${fmt(s.mean)} -> ${verdict} (<${THRESHOLD_MS}ms p95)`,
    );
    console.log(`    prefixes: ${JSON.stringify(rep?.prefixes?.[size] ?? {})}`);
  }
  if (rep?.error) console.log(`  worker error: ${rep.error}`);
  if (r.result?.error) console.log(`  page error: ${r.result.error}`);
}
console.log(`\nwrote ${out}`);
