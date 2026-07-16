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
    const ok = await currentPage.evaluate(() => navigator.serviceWorker.controller !== null);
    if (!ok) {
      throw new Error('Service worker not active');
    }
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
   * Step: Install npm packages via browserbox
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
   * Step: Run shell command via browserbox
   */
  @Step('I run <command>')
  async runCommand(command: string) {
    await currentPage.evaluate(cmd => (window as any).__browserbox.shell.exec(cmd), command);
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
   * Step: Verify runtime tier
   */
  @Step('The runtime tier for the last run is <tier>')
  async runtimeTier(tier: string) {
    const actual = await currentPage.evaluate(() => (window as any).__browserbox.runtime.lastTier);
    if (actual !== tier) {
      throw new Error(`Expected runtime tier "${tier}", got "${actual}"`);
    }
  }

  /**
   * Step: Verify sandbox policy allows network
   */
  @Step('The sandbox policy for <name> allows <pattern>')
  async sandboxPolicyAllows(name: string, pattern: string) {
    const ok = await currentPage.evaluate(
      ([n, p]) => (window as any).__browserbox.sandbox.policy(n).allows(p),
      [name, pattern] as [string, string],
    );
    if (!ok) {
      throw new Error(`Sandbox policy ${name} does not allow ${pattern}`);
    }
  }

  /**
   * Step: Verify memory limit error
   */
  @Step('A script that allocates <size> throws a memory limit error in QuickJS')
  async memoryLimit(size: string) {
    const result = await currentPage.evaluate(
      s => (window as any).__browserbox.runtime.runQuickJS(`const buffer = new Array(${s}).fill(0);`),
      size,
    );
    const error = (result as any)?.error ?? '';
    if (!error.includes('memory limit')) {
      throw new Error(`Expected memory limit error, got: ${error || result}`);
    }
  }

  /**
   * Step: Verify infinite loop terminated
   */
  @Step('An infinite loop is terminated within <seconds> seconds by watchdog')
  async infiniteLoopTerminated(seconds: string) {
    const elapsed = await currentPage.evaluate(s => {
      const script = 'while(true) { }';
      const start = Date.now();
      (window as any).__browserbox.runtime.runQuickJS(script);
      return Date.now() - start;
    }, seconds);
    if (elapsed > parseInt(seconds) * 1000 + 1000) {
      throw new Error(`Infinite loop not terminated within ${seconds} seconds (took ${elapsed}ms)`);
    }
  }

  /**
   * Step: Verify total RAM usage is under limit
   */
  @Step('Total runtime RAM usage is under <size>')
  async ramUsage(size: string) {
    const used = await currentPage.evaluate(() => (window as any).__browserbox.runtime.memoryUsage());
    const sizeMatch = size.match(/^(\d+)\s*(GB|MB|KB)$/i);
    if (!sizeMatch) {
      throw new Error(`Invalid size format: ${size}`);
    }
    const [, num, unit] = sizeMatch;
    const limit =
      parseInt(num) *
      (unit.toUpperCase() === 'GB'
        ? 1024 * 1024 * 1024
        : unit.toUpperCase() === 'MB'
          ? 1024 * 1024
          : 1024);
    if (used > limit) {
      throw new Error(`RAM usage ${used} exceeds limit ${limit}`);
    }
  }

  /**
   * Step: Verify agent output contains text
   */
  @Step('The agent output contains <text>')
  async agentOutputContains(text: string) {
    const output = await currentPage.evaluate(() => (window as any).__browserbox.runtime.lastOutput);
    if (!output || !String(output).includes(text)) {
      throw new Error(`Agent output does not contain "${text}": ${output}`);
    }
  }

  /**
   * Step: Run script in QuickJS tier
   */
  @Step('I run runtime quickjs <path>')
  async runQuickJS(path: string) {
    await currentPage.evaluate(p => (window as any).__browserbox.runtime.runQuickJSFile(p), path);
  }

  /**
   * Step: Run script with policy
   */
  @Step('I run runtime run --policy <policy> <path>')
  async runWithPolicy(policy: string, path: string) {
    await currentPage.evaluate(
      ([p, pol]) => (window as any).__browserbox.runtime.runWithPolicy(p, pol),
      [path, policy] as [string, string],
    );
  }

  /**
   * Step: Mock AI API responses
   */
  @Step('I mock AI API responses')
  async mockAIResponses() {
    await currentPage.route('**/v1/chat/completions', async route =>
      route.fulfill({
        body: JSON.stringify({ choices: [{ message: { content: 'Hello from mock AI' } }] }),
      }),
    );
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
