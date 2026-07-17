// E2E validation for TCP relay: outbound nc/tcping + HTTP curl + inbound nc -l.
// Run from tests/e2e/ so playwright resolves: `node tcp-relay-e2e.mjs`
import { chromium } from "playwright";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEMO_URL = process.env.DEMO_URL ?? "http://localhost:4321/e2e/";
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:9000";
const ECHO_PORT = 8080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAndCheck(page, label, cmd, expected, timeout = 20000) {
  console.log(`\n[${label}] typing: ${cmd}`);
  const textarea = page.locator(".xterm-helper-textarea");
  await textarea.click();
  // xterm.js's DOM renderer recycles/reorders row elements as the viewport
  // scrolls, so textContent is NOT append-only — a byte-length-prefix diff
  // against a "before" snapshot silently breaks once scrolling kicks in.
  // Count occurrences instead: robust as long as `expected` doesn't already
  // appear on screen before the command runs (true for every caller here).
  const countBefore = await page.evaluate(
    (exp) => (document.querySelector(".xterm-rows")?.textContent ?? "").split(exp).length - 1,
    expected,
  );
  await textarea.type(cmd, { delay: 10 });
  await textarea.press("Enter");

  try {
    await page.waitForFunction(
      ([exp, before]) => {
        const text = document.querySelector(".xterm-rows")?.textContent ?? "";
        return text.split(exp).length - 1 > before;
      },
      [expected, countBefore],
      { timeout },
    );
    console.log(`[${label}] PASS — found "${expected}"`);
    return { label, pass: true };
  } catch {
    const tail = await page.evaluate(
      () => (document.querySelector(".xterm-rows")?.textContent ?? "").slice(-300),
    );
    console.log(`[${label}] FAIL — expected "${expected}"`);
    console.log(`[${label}] output tail: ${JSON.stringify(tail)}`);
    return { label, pass: false, tail };
  }
}

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), "bolo-e2e-"));
  console.log(`Isolated profile: ${profileDir}`);

  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-zygote",
    ],
  });

  const page = browser.pages()[0] ?? (await browser.newPage());

  // Capture console output for debugging
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`[browser pageerror] ${err.message}`));

  const results = [];

  try {
    console.log(`Navigating to ${DEMO_URL}...`);
    await page.goto(DEMO_URL, { waitUntil: "domcontentloaded" });

    console.log("Waiting for boot ready (60s timeout)...");
    await page.waitForSelector('[data-boot-state="ready"]', { timeout: 60000 });
    console.log("Boot ready.");

    // Inject TCP relay config — read at command invocation time, not boot time
    await page.evaluate((url) => {
      globalThis.__tcpRelay = { url };
    }, RELAY_URL);
    console.log(`__tcpRelay set to ${RELAY_URL}`);
    await sleep(500);

    // Test 1: tcping — TCP outbound connect via relay
    results.push(
      await runAndCheck(
        page,
        "tcping",
        `tcping localhost ${ECHO_PORT} -c 1`,
        "open",
        20000,
      ),
    );

    // Test 2: nc — TCP data round-trip via relay (echo server prefixes "ECHO:")
    results.push(
      await runAndCheck(
        page,
        "nc",
        `nc -d testdata localhost ${ECHO_PORT}`,
        "ECHO:testdata",
        20000,
      ),
    );

    // Test 3: curl — HTTP outbound via fetch (same-origin to dev server)
    results.push(
      await runAndCheck(
        page,
        "curl",
        "curl -s http://localhost:4321/",
        "bolo",
        15000,
      ),
    );

    // Test 4: inbound — browser listens via relay, driver connects over real TCP.
    // `nc -l` prints accepted data to stdout; wait for it in the terminal.
    const LISTEN_PORT = 18081;
    const INBOUND_TOKEN = "inbound-hello";
    const textarea = page.locator(".xterm-helper-textarea");
    console.log(`\n[nc -l] typing: nc -l -w 30 ${LISTEN_PORT}`);
    await textarea.click();
    await textarea.type(`nc -l -w 30 ${LISTEN_PORT}`, { delay: 10 });
    await textarea.press("Enter");

    // Retry-connect until the relay's listener is bound (LISTEN round-trip is async).
    let client;
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        client = await new Promise((resolve, reject) => {
          const c = net.createConnection(LISTEN_PORT, "127.0.0.1", () => resolve(c));
          c.on("error", reject);
        });
        break;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`relay listener never came up: ${e.message}`);
        await sleep(500);
      }
    }
    client.write(INBOUND_TOKEN);
    await sleep(300);
    client.end();

    try {
      await page.waitForFunction(
        (exp) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(exp),
        INBOUND_TOKEN,
        { timeout: 15000 },
      );
      console.log(`[nc -l] PASS — found "${INBOUND_TOKEN}"`);
      results.push({ label: "nc -l (inbound)", pass: true });
    } catch {
      const tail = await page.evaluate(
        () => (document.querySelector(".xterm-rows")?.textContent ?? "").slice(-300),
      );
      console.log(`[nc -l] FAIL — expected "${INBOUND_TOKEN}"`);
      console.log(`[nc -l] output tail: ${JSON.stringify(tail)}`);
      results.push({ label: "nc -l (inbound)", pass: false, tail });
    }
  } catch (e) {
    console.error("E2E error:", e.message ?? e);
    results.push({ label: "bootstrap", pass: false, error: String(e) });
    // Screenshot for debugging
    await page.screenshot({ path: "/tmp/bolo-e2e-failure.png", fullPage: true }).catch(() => {});
    console.log("Screenshot saved to /tmp/bolo-e2e-failure.png");
  } finally {
    await browser.close();
  }

  console.log("\n========== E2E RESULTS ==========");
  for (const r of results) {
    const s = r.pass ? "PASS" : "FAIL";
    console.log(`  ${s}: ${r.label}`);
  }
  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? "ALL PASSED" : "FAILURES DETECTED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
