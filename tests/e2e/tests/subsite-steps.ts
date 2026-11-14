import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

const BASE_URL = process.env.DEMO_URL ?? 'http://localhost:4321/e2e/';

/**
 * SubsiteSteps - boots each catalog subsite route (/ide, /sandbox, /app,
 * /vibe) and asserts the shared shell renders its panels with a booted
 * container and no service-worker errors.
 */
export default class SubsiteSteps {
  /**
   * Step: Navigate to a subsite route. Resolves against DEMO_URL so both the
   * default harness origin and CI overrides work.
   */
  @Step('I open the subsite page <route>')
  async openSubsite(route: string) {
    await currentPage.goto(new URL(route, BASE_URL).toString());
  }

  /**
   * Step: The subsite SW (longest-scope match for the page) is controlling it.
   * The suite shares one persistent browser profile across specs, so a
   * previously-registered SW (e.g. the root "/sw.js") can still be the
   * controller right after navigation; poll until claim() hands control to
   * the subsite worker.
   */
  @Step('The subsite service worker at <path> controls the page')
  async subsiteSwControls(path: string) {
    await currentPage.waitForFunction(
      (expected) => navigator.serviceWorker.controller?.scriptURL.endsWith(expected) ?? false,
      path,
      { timeout: 15000 },
    );
  }

  /**
   * Step: Assert the shell's data-panels attribute lists exactly the panels.
   */
  @Step('The subsite shell shows the panels <panels>')
  async subsitePanels(panels: string) {
    const expected = panels.trim().split(/\s+/).sort();
    await currentPage.waitForSelector('[data-subsite][data-boot-state]', { timeout: 15000 });
    const actual = await currentPage.evaluate(() => {
      const shell = document.querySelector('[data-subsite]');
      return shell?.getAttribute('data-panels')?.trim().split(/\s+/).sort() ?? [];
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Expected panels ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  /**
   * Step: Wait for the subsite runtime to reach the "ready" boot state.
   */
  @Step('The subsite runtime is ready')
  async subsiteRuntimeReady() {
    await currentPage.waitForSelector('[data-subsite][data-boot-state="ready"]', {
      timeout: 60000,
    });
  }

  /**
   * Step: Drain the observability buffer and fail on any SW-sourced record.
   */
  @Step('No service worker errors were recorded')
  async noSwErrors() {
    await currentPage.waitForTimeout(1000);
    const records = await currentPage.evaluate(() => {
      const drain = (window as unknown as { __boloObsDrain?: () => { source: string; message: string }[] })
        .__boloObsDrain;
      return drain?.() ?? [];
    });
    const swErrors = records.filter((record) => record.source === 'sw');
    if (swErrors.length > 0) {
      throw new Error(
        `Service worker errors recorded: ${swErrors.map((record) => record.message).join(' | ')}`,
      );
    }
  }
}
