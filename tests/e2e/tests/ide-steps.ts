import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

/**
 * IdeSteps - drives the /ide workbench through its real UI: template picker,
 * file tree, CodeMirror editor, terminal and preview iframe.
 */
export default class IdeSteps {
  @Step('I pick the IDE template <id>')
  async pickTemplate(id: string) {
    const button = `[data-template="${id}"]:not([disabled])`;
    await currentPage.waitForSelector(button, { timeout: 90000 });
    await currentPage.click(button);
    await currentPage.waitForSelector('[data-subsite][data-boot-state="ready"]', {
      timeout: 180000,
    });
  }

  @Step('The IDE file tree lists <path>')
  async fileTreeLists(path: string) {
    await currentPage.waitForSelector(`[data-panel="file-tree"] [data-file="${path}"]`, {
      state: 'attached',
      timeout: 30000,
    }).catch(async () => {
      // Parent directories start collapsed: expand each ancestor, then retry.
      const parts = path.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const dir = '/' + parts.slice(0, i).join('/');
        const button = currentPage.locator(`[data-panel="file-tree"] [data-file="${dir}"]`);
        if (await button.count()) {
          const arrow = (await button.first().innerText()).trim();
          if (arrow.startsWith('▸')) await button.first().click();
        }
      }
      await currentPage.waitForSelector(`[data-panel="file-tree"] [data-file="${path}"]`, {
        timeout: 10000,
      });
    });
  }

  @Step('The IDE terminal output contains <text>')
  async terminalContains(text: string) {
    await currentPage.waitForFunction(
      t => document.querySelector('.xterm-rows')?.textContent?.includes(t) ?? false,
      text,
      { timeout: 30000 },
    );
  }

  @Step('The IDE preview shows <text>')
  async previewShows(text: string) {
    await currentPage.waitForFunction(
      t => {
        const iframe = document.querySelector('iframe[data-preview]') as HTMLIFrameElement | null;
        return iframe?.contentDocument?.body?.innerText?.includes(t) ?? false;
      },
      text,
      { timeout: 60000 },
    );
  }

  @Step('I edit the IDE file <path> to render the heading <heading>')
  async editFile(path: string, heading: string) {
    await this.fileTreeLists(path);
    await currentPage.click(`[data-panel="file-tree"] [data-file="${path}"]`);
    const content = currentPage.locator('[data-panel="editor"] .cm-content');
    await content.click();
    await currentPage.keyboard.press('ControlOrMeta+A');
    await currentPage.keyboard.press('Backspace');
    await currentPage.keyboard.insertText(
      `export default function App() { return <h1>${heading}</h1>; }`,
    );
  }

  @Step('The IDE preview origin returns <text> for <path>')
  async previewApi(text: string, path: string) {
    await currentPage.waitForFunction(
      async ([p, t]) => {
        const res = await fetch(p, { cache: 'no-store' });
        return res.ok && (await res.text()).includes(t);
      },
      [path, text] as [string, string],
      { timeout: 30000 },
    );
  }
}
