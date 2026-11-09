/**
 * Kill check: `Process.kill()` on a program stuck in `while (1) {}` must
 * resolve `exit` within 1s, terminate the worker thread (browser limit: ~2s) while the host page's main thread stays
 * responsive (setInterval heartbeat max gap < 250ms). Usage:
 *   tsx tests/differential/kill.ts --url http://localhost:5174
 * Exit 1 on failure.
 */
import { chromium } from "playwright-core";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const url = arg("url", "http://localhost:5173");
const RECLAIM_LIMIT_MS = 1000;
// Chromium (Blink) forcibly stops a worker stuck in synchronous script only after a
// fixed 2s delay following terminate(); measured at ~2.0s. See BOLO-DIV-003.
const THREAD_LIMIT_MS = 5000;
const GAP_LIMIT_MS = 250;

const main = async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || undefined });
  const page = await (await browser.newContext()).newPage();
  const t0 = Date.now();
  // Playwright's worker 'close' event lags; ask the browser which worker targets are alive.
  const cdp = await browser.newBrowserCDPSession();
  const workerCount = async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "worker" && t.url.includes("node-process-worker")).length;
  };
  await page.goto(url, { timeout: 120_000 });
  await page.waitForFunction(() => typeof (window as any).__compatHarness !== "undefined");
  await page.evaluate(() => (window as any).__compatHarness.boot());
  await page.evaluate(() => (window as any).__compatHarness.write("/kill/spin.js", 'console.log("spinning");\nwhile (1) {}\n'));

  // Heartbeat on the host main thread, running across spawn + kill.
  await page.evaluate(() => {
    const w = window as any;
    w.__hb = { max: 0, last: performance.now() };
    setInterval(() => {
      const now = performance.now();
      w.__hb.max = Math.max(w.__hb.max, now - w.__hb.last);
      w.__hb.last = now;
    }, 20);
  });
  const baseline = await workerCount();
  const spawned = page.evaluate(() => (window as any).__compatHarness.spawnAndKill("/kill/spin.js") as Promise<{ killMs: number; exitCode: number; output: string }>);
  // Wait until the spinning process worker exists, then let spawnAndKill kill it.
  let peak = baseline;
  const res = await spawned;
  const killAt = Date.now();
  peak = Math.max(peak, await workerCount());
  let reclaimMs = Infinity;
  while (Date.now() - killAt < THREAD_LIMIT_MS) {
    if ((await workerCount()) <= baseline) {
      reclaimMs = Date.now() - killAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const maxGap = await page.evaluate(() => (window as any).__hb.max as number);
  await browser.close();

  const report = { baselineProcessWorkers: baseline, peakProcessWorkers: peak, exitResolveMs: Math.round(res.killMs), exitCode: res.exitCode, reclaimMs, maxHeartbeatGapMs: Math.round(maxGap), sawOutput: res.output.includes("spinning"), elapsedMs: Date.now() - t0 };
  console.log(JSON.stringify(report));
  // Host-visible reclaim (exit resolved, output gated, RPC/sync handlers detached) must be
  // within 1s; the OS thread itself must die within 5s; the page must stay responsive.
  const ok =
    report.sawOutput && res.killMs < RECLAIM_LIMIT_MS && reclaimMs < THREAD_LIMIT_MS && maxGap < GAP_LIMIT_MS;
  if (!ok) console.error("FAIL: exit < 1000ms, worker thread gone < 5000ms, heartbeat gap < 250ms");
  process.exit(ok ? 0 : 1);
};
void main();
