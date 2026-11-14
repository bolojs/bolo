import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

/**
 * SandboxSteps - drives the /sandbox subsite's terminal-first UI: the
 * example chip row, the Script/REPL tab bar, and terminal assertions. Reuses
 * the generic "I run <cmd> in the terminal" / "The terminal output contains"
 * steps from BrowserSteps for typed input and output checks.
 */
export default class SandboxSteps {
  /**
   * Step: Switch to the REPL tab in the sandbox tab bar.
   */
  @Step('I switch to the REPL tab')
  async switchToReplTab() {
    await currentPage.getByRole('tab', { name: 'REPL' }).click();
    await currentPage.waitForSelector('[data-terminal-tab="repl"]', { timeout: 5000 });
  }

  /**
   * Step: Click an example chip. Chips are static (no marquee), so a plain
   * role-based click settles immediately.
   */
  @Step('I click the example chip <label>')
  async clickExampleChip(label: string) {
    await currentPage
      .getByRole('button', { name: label, exact: true })
      .click({ timeout: 10000 });
  }

  /**
   * Step: The sandbox starts a user server and the shared Preview panel
   * appears next to the terminal.
   */
  @Step('A preview is shown for the sandbox server')
  async previewShown() {
    await currentPage.waitForSelector('iframe[data-preview]', { timeout: 15000 });
  }
}
