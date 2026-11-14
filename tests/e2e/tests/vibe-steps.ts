import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

const BASE_URL = process.env.DEMO_URL ?? 'http://localhost:4321/e2e/';

/**
 * VibeSteps - drives the /vibe subsite end-to-end with the deterministic mock
 * provider (localStorage bolo-vibe:provider=mock, set via addInitScript before
 * any navigation): one chat turn writes src/App.jsx and starts the Vite dev
 * server, and the preview iframe renders the file the assistant wrote.
 */
export default class VibeSteps {
  @Step('I open the subsite page <route> with the mock provider configured')
  async openSubsiteWithMock(route: string) {
    await currentPage.addInitScript(() => {
      localStorage.setItem('bolo-vibe:provider', 'mock');
    });
    await currentPage.goto(new URL(route, BASE_URL).toString());
  }

  @Step('The key-stays-local banner is visible')
  async keyBannerVisible() {
    await currentPage.waitForSelector('[data-testid="key-banner"]', { timeout: 15000 });
  }

  @Step('I send the chat prompt <prompt>')
  async sendPrompt(prompt: string) {
    const textarea = currentPage.locator('[data-panel="chat"] textarea');
    await textarea.waitFor({ timeout: 15000 });
    await textarea.fill(prompt);
    await currentPage.locator('button[aria-label="Send"]').click();
  }

  @Step('The chat shows a done receipt for <tool> on <detail>')
  async doneReceiptFor(tool: string, detail: string) {
    const toolName = tool.replace(/"/g, '');
    await currentPage.waitForFunction(
      ({ toolName: name, detail: d }) => {
        const receipts = Array.from(
          document.querySelectorAll(`[data-tool-receipt="${name}"][data-status="done"]`),
        );
        return receipts.some((el) => el.textContent?.includes(d));
      },
      { toolName, detail },
      { timeout: 30000 },
    );
  }

  @Step('The assistant reports the dev server is running')
  async assistantReportsDevServer() {
    await currentPage.waitForFunction(() => {
      const turns = Array.from(document.querySelectorAll('[data-turn="assistant"]'));
      return turns.some((el) => el.textContent?.includes('dev server'));
    }, undefined, { timeout: 30000 });
  }

  @Step('The preview shows the text <text>')
  async previewShows(text: string) {
    const expected = text.replace(/"/g, '');
    // The preview iframe loads on the SW virtual origin, so it is a separate
    // frame; poll its body text until the dev server serves the written file.
    await currentPage.waitForFunction(
      (marker) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[data-preview]');
        try {
          return frame?.contentDocument?.body?.textContent?.includes(marker) ?? false;
        } catch {
          return false;
        }
      },
      expected,
      { timeout: 90000 },
    );
  }
}
