import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', err => errors.push(`PAGE: ${err.message}`));

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const ready = await page.evaluate(() => window.__browserbox_ready);
const bootState = await page.evaluate(() => {
  const el = document.querySelector('.app-status');
  return el ? el.textContent : null;
});

console.log(JSON.stringify({ ready, bootState, errors }, null, 2));

await browser.close();
