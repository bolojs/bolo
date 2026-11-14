import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

/**
 * AppSteps - drives the /app full-stack subsite: select a backend route,
 * edit its handler in CodeMirror, send a request through the virtual origin
 * and read the response viewer.
 */
export default class AppSteps {
  @Step('I reset the backend routes to the starters')
  async resetRoutes() {
    await currentPage.getByTestId('reset-routes').click();
    await currentPage.waitForLoadState('load');
    await currentPage.waitForSelector('[data-subsite][data-boot-state="ready"]', { timeout: 60000 });
  }

  @Step('I select the backend route file <file>')
  async selectRoute(file: string) {
    await currentPage.click(`[data-route-file$="${file}"]`);
    await currentPage.waitForSelector('.cm-content', { timeout: 10000 });
  }

  @Step('I send the request')
  async sendRequest() {
    const before = await currentPage.getByTestId('response-body').textContent();
    await currentPage.getByTestId('send').click();
    await currentPage.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="response-body"]');
        const status = document.querySelector('[data-testid="response-status"]');
        return (
          !!el &&
          !!status &&
          !/No response yet/.test(status.textContent ?? '') &&
          (el.textContent !== prev || /^\d/.test(status.textContent ?? ''))
        );
      },
      before,
      { timeout: 15000 },
    );
  }

  @Step('The response status is <status>')
  async responseStatus(status: string) {
    await currentPage.waitForFunction(
      (expected) =>
        (document.querySelector('[data-testid="response-status"]')?.textContent ?? '').startsWith(expected),
      status,
      { timeout: 10000 },
    );
  }

  @Step('The response body contains <text>')
  async responseContains(text: string) {
    await currentPage.waitForFunction(
      (expected) =>
        (document.querySelector('[data-testid="response-body"]')?.textContent ?? '').includes(expected),
      text,
      { timeout: 10000 },
    );
  }

  /**
   * Replace the whole active editor document with a handler that returns the
   * given message, then wait for the live reload ("applied") to settle.
   */
  @Step('I change the hello handler message to <message>')
  async editHello(message: string) {
    const source = `export default {\n  method: "GET",\n  path: "/api/v1/hello",\n  handler: async () => Response.json({ message: ${JSON.stringify(message)} }),\n};\n`;
    await currentPage.click('.cm-content');
    await currentPage.keyboard.press('ControlOrMeta+a');
    await currentPage.keyboard.press('Delete');
    await currentPage.keyboard.insertText(source);
    await currentPage.waitForSelector('[data-testid="applied"]', { timeout: 10000 });
  }
}
