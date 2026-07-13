import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (msg) => console.log("console:", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("pageerror:", err.message));
page.on("requestfailed", (req) =>
  console.log("requestfailed:", req.url(), req.failure()?.errorText),
);
page.on("response", (res) => {
  if (!res.url().includes("localhost:4173")) return;
  const ct = res.headers()["content-type"];
  if (!ct || ct.includes("text/html")) console.log("response:", res.status(), ct, res.url());
});
await page.goto("http://localhost:4173", { timeout: 120000 });
console.log("goto done");
try {
  await page.waitForFunction(() => typeof window.__compatHarness !== "undefined", undefined, {
    timeout: 120000,
  });
  console.log("waitForFunction done");
} catch (e) {
  console.log("waitForFunction error:", e.message);
}
await browser.close();
