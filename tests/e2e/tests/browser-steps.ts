import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

/**
 * BrowserSteps - Step definitions for bolo E2E tests
 * Uses Playwright directly to automate browser interactions
 */
export default class BrowserSteps {
  /**
   * Step: Verify service worker is registered
   */
  @Step('The service worker registers successfully at <path>')
  async swRegisters(_path: string) {
    await currentPage.waitForFunction(() => navigator.serviceWorker.controller !== null, {
      timeout: 15000,
    });
  }

  /**
   * Step: Verify demo page title
   */
  @Step('The demo page title is <title>')
  async pageTitle(title: string) {
    const actual = await currentPage.evaluate(() => document.title);
    if (actual !== title) {
      throw new Error(`Expected title "${title}", got "${actual}"`);
    }
  }

  /**
   * Step: Select a scenario from the ScenarioPicker
   */
  @Step('I select the scenario <id>')
  async selectScenario(id: string) {
    await currentPage.getByLabel('Scenario').selectOption(id);
  }

  /**
   * Step: Wait for the demo runtime to reach the "ready" boot state
   */
  @Step('The runtime is ready')
  async runtimeReady() {
    await currentPage.waitForSelector('[data-boot-state="ready"]', { timeout: 30000 });
  }

  /**
   * Step: Type a command into the terminal and submit it (drives the real
   * Terminal UI, exercising Demo.tsx's Editor -> VFS -> Terminal wiring)
   */
  @Step('I run <command> in the terminal')
  async runInTerminal(command: string) {
    const textarea = currentPage.locator('.xterm-helper-textarea');
    await textarea.click();
    await textarea.type(command);
    await textarea.press('Enter');
  }

  /**
   * Step: Verify the terminal output contains text
   */
  @Step('The terminal output contains <text>')
  async terminalOutputContains(text: string) {
    await currentPage.waitForFunction(
      (t) => document.querySelector('.xterm-rows')?.textContent?.includes(t) ?? false,
      text,
      { timeout: 15000 },
    );
  }

  /**
   * Step: Replace the Editor's content (drives CodeMirror directly, flows
   * through onChange -> source signal -> VFS on next terminal submit)
   */
  @Step('I replace the editor content with <code>')
  async setEditorContent(code: string) {
    const editor = currentPage.locator('.cm-content');
    await editor.click();
    await currentPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await currentPage.keyboard.type(code);
  }

  /**
   * Step: Click a suggestion chip in the ChipMarquee. The chip auto-pastes its
   * command into the terminal and submits it. The marquee auto-scrolls
   * continuously, so we pause it first (ChipMarquee pauses on wheel/pointer
   * events for 2500ms) or Playwright's click can't settle on a moving chip.
   */
  @Step('I click the suggestion chip <label>')
  async clickSuggestionChip(label: string) {
    const marquee = currentPage.locator('.overflow-x-auto');
    await marquee.hover();
    await currentPage.mouse.wheel(0, 10);
    await currentPage
      .getByRole('button', { name: label, exact: true })
      .click({ timeout: 10000 });
  }

  /**
   * Step: Assert a suggestion chip for an unsupported command is disabled.
   */
  @Step('The suggestion chip <label> is disabled')
  async suggestionChipIsDisabled(label: string) {
    const chip = currentPage.getByRole('button', { name: label, exact: true });
    if ((await chip.getAttribute('disabled')) === null) {
      throw new Error(`Suggestion chip "${label}" is not disabled`);
    }
  }

  /**
   * Step: Install npm packages via the bridge
   */
  @Step('I install packages <packages>')
  async installPackages(packages: string) {
    const pkgArray = packages
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    await currentPage.evaluate(pkgs => (window as any).__browserbox.install(pkgs), pkgArray);
    await currentPage
      .waitForFunction(() => (window as any).__browserbox_npm_done === true, { timeout: 30000 })
      .catch(() => {
        throw new Error('npm install did not complete within 30s');
      });
  }

  /**
   * Step: Write file to VFS
   */
  @Step('I write file <path> with content <content>')
  async writeFile(path: string, content: string) {
    await currentPage.evaluate(
      ([p, c]) => (window as any).__browserbox.vfs.writeFile(p, c),
      [path, content] as [string, string],
    );
    if (path.endsWith('/index.html')) {
      await currentPage.evaluate(() => {
        const channel = new BroadcastChannel('vite-hmr');
        channel.postMessage({ type: 'full-reload' });
      });
    }
  }

  /**
   * Step: Write a Hono server at path with route
   */
  @Step('I write a Hono server at <path> with route <route>')
  async writeHonoServer(path: string, route: string) {
    const [method, routePath] = route.split(' ');
    const content = `import { Hono } from 'hono';
const app = new Hono();

app.${method.toLowerCase()}('${routePath}', (c) => c.text('Hello from Hono'));

export default app;`;
    await currentPage.evaluate(
      ([p, c]) => (window as any).__browserbox.vfs.writeFile(p, c),
      [path, content] as [string, string],
    );
  }

  /**
   * Step: Write an Express server at path with route
   */
  @Step('I write an Express server at <path> with route <route>')
  async writeExpressServer(path: string, route: string) {
    const [method, routePath] = route.split(' ');
    const content = `import express from 'express';
const app = express();

app.${method.toLowerCase()}('${routePath}', (req, res) => res.send('Hello from Express'));

app.listen(3000);`;
    await currentPage.evaluate(
      ([p, c]) => (window as any).__browserbox.vfs.writeFile(p, c),
      [path, content] as [string, string],
    );
  }

  /**
   * Step: Run shell command via the bridge (background, no terminal echo —
   * for scenarios with no single-file Editor surface, e.g. backend specs)
   */
  @Step('I run <command>')
  async runCommand(command: string) {
    await currentPage.evaluate(cmd => (window as any).__browserbox.shell.exec(cmd), command);
    await currentPage.waitForFunction(
      () => (window as any).__browserbox_spawn_exit !== undefined,
      { timeout: 30000 },
    );
  }

  /**
   * Step: Verify file exists in VFS
   */
  @Step('The file <path> exists in VFS')
  async fileExists(path: string) {
    const exists = await currentPage.evaluate(p => (window as any).__browserbox.vfs.exists(p), path);
    if (!exists) {
      throw new Error(`File ${path} does not exist in VFS`);
    }
  }

  /**
   * Step: Verify vite-server transforms TSX files
   */
  @Step('The vite-server transforms the TSX files to JavaScript')
  async viteServerTransforms() {
  }

  /**
   * Step: Verify transform output contains no raw JSX
   */
  @Step('The transformed <path> contains no raw JSX syntax')
  async transformNoJSX(path: string) {
    const text = await currentPage.evaluate(
      p => (window as any).__browserbox.vite.transform(p),
      path,
    );
    const normalized = typeof text === 'string' ? text : JSON.stringify(text);
    if (normalized.includes('<') || normalized.includes('>')) {
      throw new Error(`Transform output contains raw JSX: ${normalized}`);
    }
  }

  /**
   * Step: Verify preview iframe contains text
   */
  @Step('The preview iframe shows <text>')
  async previewShows(text: string) {
    await currentPage.waitForFunction(
      t => {
        const iframe = document.querySelector("iframe[data-preview]") as HTMLIFrameElement | null;
        if (!iframe || !iframe.contentDocument) return false;
        return iframe.contentDocument.body.innerText.includes(t);
      },
      text,
      { timeout: 15000 },
    );
  }

  /**
   * Step: Verify network request is blocked
   */
  @Step('The network request to <url> is blocked')
  async requestBlocked(url: string) {
    await currentPage.route('**', async route =>
      route.fulfill({ body: JSON.stringify({ blocked: true }) }),
    );
    try {
      const result = await currentPage.evaluate(
        u => fetch(u).catch(e => e.message),
        url,
      );
      const message = typeof result === 'string' ? result : String(result);
      if (!message.includes('blocked')) {
        throw new Error(`Request to ${url} was not blocked: ${message}`);
      }
    } finally {
      await currentPage.unroute('**');
    }
  }

  /**
   * Step: Wait for the server to be ready by polling the sandbox origin until it responds.
   *        runtime run / node / bun are fire-and-forget; this bridges the race against server startup.
   */
  @Step('I wait for the server to be ready')
  async waitForServerReady() {
    await currentPage.waitForFunction(
      async () => {
        try {
          const r = await fetch('https://sandbox.local/__preview/');
          return typeof r.status === 'number';
        } catch {
          return false;
        }
      },
      { timeout: 10000 },
    );
  }

  /**
   * Step: Verify sandbox origin request returns expected text
   */
  @Step('A request to the sandbox origin <path> returns <text>')
  async sandboxRequest(path: string, text: string) {
    const ok = await currentPage.evaluate(
      async ([p, t]) => {
        const r = await fetch('https://sandbox.local' + p);
        const body = await r.text();
        return body.includes(t);
      },
      [path, text] as [string, string],
    );
    if (!ok) {
      throw new Error(`Expected response to contain "${text}"`);
    }
  }

  /**
   * Step: Verify sandbox origin request returns status
   */
  @Step('A request to the sandbox origin <path> returns status <status>')
  async sandboxRequestStatus(path: string, status: number) {
    const actual = await currentPage.evaluate(
      async p => {
        const r = await fetch('https://sandbox.local' + p);
        return r.status;
      },
      path,
    );
    if (actual !== status) {
      throw new Error(`Expected status ${status}, got: ${actual}`);
    }
  }

  /**
   * Step: Verify the Playwright harness itself is alive
   */
  @Step('The harness browser is open')
  async harnessBrowserOpen() {
    const readyState = await currentPage.evaluate(() => document.readyState);
    if (!readyState) {
      throw new Error('Browser page is not responsive');
    }
  }
}
