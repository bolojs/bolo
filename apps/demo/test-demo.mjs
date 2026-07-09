import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', msg => {
  const type = msg.type();
  const text = msg.text();
  if (type === 'error' || text.includes('EventEmitter') || text.includes('undefined')) {
    console.log(`[${type}] ${text}`);
  }
});

page.on('pageerror', err => {
  console.log(`[PAGE ERROR] ${err.message}`);
});

await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const title = await page.title();
const html = await page.content();
const hasApp = html.includes('browser-containers') || html.includes('browsercontainers');
const hasBootState = html.includes('booting') || html.includes('ready') || html.includes('error');
const bodyText = await page.locator('body').innerText();

console.log(JSON.stringify({ title, hasApp, hasBootState, bodyText: bodyText.slice(0, 200) }, null, 2));

await browser.close();
