import {
  BeforeSuite,
  AfterSuite,
  BeforeSpec,
  AfterSpec,
  CustomScreenshotWriter,
} from 'gauge-ts';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let browser: Browser;
let context: BrowserContext;
export let currentPage: Page;

export default class Hooks {
  @BeforeSuite()
  async beforeSuite() {
    const headless = process.env.headless !== 'false';
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-zygote',
        '--window-size=1440,900',
      ],
    });
    mkdirSync('reports', { recursive: true });
    mkdirSync('screenshots', { recursive: true });
  }

  @BeforeSpec()
  async beforeSpec() {
    context = await browser.newContext();
    currentPage = await context.newPage();
    await currentPage.goto(process.env.DEMO_URL ?? 'http://localhost:4321/e2e/');
  }

  @CustomScreenshotWriter()
  public takeScreenshot(): string {
    // gauge-ts 0.5.1 types this as a sync string return. Screenshot.capture()
    // records the returned path; the file write is fire-and-forget. The failure-
    // screenshot path writes here, so the PNG exists by report-generation time.
    const dir = process.env.gauge_screenshots_dir ?? 'screenshots';
    const filename = join(dir, `failure-${Date.now()}.png`);
    currentPage?.screenshot({ path: filename, fullPage: true }).catch(() => {});
    return filename;
  }

  @AfterSpec()
  async afterSpec() {
    await context?.close();
  }

  @AfterSuite()
  async afterSuite() {
    await browser?.close();
  }
}
