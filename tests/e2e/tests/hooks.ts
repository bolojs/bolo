import {
  BeforeSuite,
  AfterSuite,
  BeforeSpec,
  AfterSpec,
  AfterScenario,
  CustomScreenshotWriter,
  type ExecutionContext,
} from 'gauge-ts';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { configureBoloLogging } from '@bolojs/log';

// Dedicated, isolated browser profile. Other agents/concurrent Playwright runs
// share the default Chrome singleton lock; a fixed userDataDir here sidesteps
// that contention. It also persists the service worker registration across
// specs, making swRegisters reliable.
const PROFILE_DIR = join(tmpdir(), 'gauge-bolo-chrome');

let context: BrowserContext;
export let currentPage: Page;

export default class Hooks {
  @BeforeSuite()
  async beforeSuite() {
    await configureBoloLogging();
    const headless = process.env.headless !== 'false';
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
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
    currentPage = await context.newPage();
    const url = process.env.DEMO_URL ?? 'http://localhost:4321/e2e/';
    await currentPage.goto(url);
    // The profile is persistent (for SW registrations) and every subsite shares
    // one origin and the same /home/web workdir, so the VFS cold tier (OPFS +
    // IDB fallback) written by one spec would hydrate into the next spec's
    // project. Wipe it so each spec starts from its own starter tree.
    await currentPage.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('vfs-bus-opfs-fallback');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }).catch(() => {});
    await currentPage.goto(url);
  }

  // gauge-ts runtime awaits Promises (Screenshot.capture checks
  // out.constructor.name === Promise.name, then `return await out`), so an
  // async writer works — but the decorator type is `CommonFunction<string>`.
  // @ts-expect-error gauge-ts type doesn't reflect its own async runtime support
  @CustomScreenshotWriter()
  public async takeScreenshot(): Promise<string> {
    const dir = process.env.gauge_screenshots_dir ?? 'screenshots';
    const name = `failure-${Date.now()}.png`;
    const fullPath = join(dir, name);
    await currentPage?.screenshot({ path: fullPath, fullPage: true }).catch(() => {});
    return name;
  }

  @AfterSpec()
  async afterSpec() {
    await currentPage?.close();
  }

  @AfterScenario()
  async afterScenario(context: ExecutionContext) {
    if (context.getCurrentScenario()?.getIsFailing()) {
      console.error('bolo diagnostics: .logs/latest.jsonl');
    }
  }

  @AfterSuite()
  async afterSuite() {
    await context?.close();
  }
}
