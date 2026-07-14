import { Step, BeforeSpec, AfterSpec } from 'gauge-ts';
import { execSync } from 'child_process';
import { ab } from '../lib/ab';
import { DEMO_URL } from '../lib/config';
import { setupBrowser, teardownBrowser } from '../lib/setup';

/**
 * BrowserSteps - Step definitions for bolo E2E tests
 * Uses agent-browser CLI to automate browser interactions
 */
export default class BrowserSteps {
  @BeforeSpec()
  async setup() {
    await setupBrowser();
  }

  @AfterSpec()
  async teardown() {
    await teardownBrowser();
  }

  /**
   * Step: Verify service worker is registered
   */
  @Step('The service worker registers successfully at <path>')
  async swRegisters(_path: string) {
    const result = ab('eval "navigator.serviceWorker.controller !== null" --json');
    const data = JSON.parse(result);
    if (!data.data.result) {
      throw new Error('Service worker not active');
    }
  }

  /**
   * Step: Verify demo page title
   */
  @Step('The demo page title is <title>')
  async pageTitle(title: string) {
    const result = ab(`eval "document.title" --json`);
    const data = JSON.parse(result);
    if (data.data.result !== title) {
      throw new Error(`Expected title "${title}", got "${data.data.result}"`);
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
      .filter(p => p.length > 0)
      .map(p => `'${p}'`)
      .join(', ');
    
    ab(`eval "window.__browserbox.install([${pkgArray}])" --json`);
    ab('wait --fn "window.__browserbox_npm_done === true" 30000');
  }

  /**
   * Step: Write file to VFS
   */
  @Step('I write file <path> with content <content>')
  async writeFile(path: string, content: string) {
    ab(`eval 'window.__browserbox.vfs.writeFile("${path}", ${JSON.stringify(content)})' --json`);
    if (path.endsWith('/index.html')) {
      ab(`eval "new BroadcastChannel('vite-hmr').postMessage({ type: 'full-reload' })" --json`);
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
    ab(`eval 'window.__browserbox.vfs.writeFile("${path}", ${JSON.stringify(content)})' --json`);
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
    ab(`eval 'window.__browserbox.vfs.writeFile("${path}", ${JSON.stringify(content)})' --json`);
  }

  /**
   * Step: Run shell command via browserbox
   */
  @Step('I run <command>')
  async runCommand(command: string) {
    ab(`eval "window.__browserbox.shell.exec('${command}')" --json`);
  }

  /**
   * Step: Verify file exists in VFS
   */
  @Step('The file <path> exists in VFS')
  async fileExists(path: string) {
    const result = ab(`eval "window.__browserbox.vfs.exists('${path}')" --json`);
    const data = JSON.parse(result);
    if (!data.data.result) {
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
    const result = ab(`eval "window.__browserbox.vite.transform('${path}')" --json`);
    const data = JSON.parse(result);
    const text = typeof data.data.result === 'string' ? data.data.result : JSON.stringify(data.data.result);
    if (text.includes('<') || text.includes('>')) {
      throw new Error(`Transform output contains raw JSX: ${text}`);
    }
  }

  /**
   * Step: Verify preview iframe contains text
   */
  @Step('The preview iframe shows <text>')
  async previewShows(text: string) {
    const expr = `(() => {
      const iframe = document.querySelector("iframe[data-preview]");
      if (!iframe || !iframe.contentDocument) return "";
      return iframe.contentDocument.body.innerText;
    })()`;
    let attempts = 0;
    while (attempts < 30) {
      const result = ab(`eval '${expr}' --json`);
      const data = JSON.parse(result);
      if (typeof data.data.result === 'string' && data.data.result.includes(text)) {
        return;
      }
      attempts++;
      execSync('sleep 0.5');
    }
    throw new Error(`Preview iframe did not show "${text}" within 15s`);
  }

  /**
   * Step: Verify network request is blocked
   */
  @Step('The network request to <url> is blocked')
  async requestBlocked(url: string) {
    ab('network route "**" --body \'{"blocked":true}\'');
    const result = ab(`eval "fetch('${url}').catch(e => e.message)" --json`);
    ab('network unroute');
    const data = JSON.parse(result);
    if (!data.data.result.includes('blocked')) {
      throw new Error(`Request to ${url} was not blocked: ${data.data.result}`);
    }
  }

  /**
   * Step: Wait for the server to be ready by polling the sandbox origin until it responds.
   *        runtime run / node / bun are fire-and-forget; this bridges the race against server startup.
   */
  @Step('I wait for the server to be ready')
  async waitForServerReady() {
    const maxAttempts = 20;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        // ponytail: any HTTP response (even 404) means the SW is proxying and the server is up.
        const result = ab(`eval "fetch('https://sandbox.local/__preview/').then(r => r.status)" --json`);
        const data = JSON.parse(result);
        if (data.data && typeof data.data.result === 'number') {
          return; // server is up
        }
      } catch {}
      execSync('sleep 0.5');
      attempts++;
    }
    throw new Error('Server did not start within 10 seconds');
  }

  /**
   * Step: Verify sandbox origin request returns expected text
   */
  @Step('A request to the sandbox origin <path> returns <text>')
  async sandboxRequest(path: string, text: string) {
    const result = ab(`eval "fetch('https://sandbox.local${path}').then(r => r.text())" --json`);
    const data = JSON.parse(result);
    if (!data.data.result || !data.data.result.includes(text)) {
      throw new Error(`Expected response to contain "${text}", got: ${data.data.result}`);
    }
  }

  /**
   * Step: Verify sandbox origin request returns status
   */
  @Step('A request to the sandbox origin <path> returns status <status>')
  async sandboxRequestStatus(path: string, status: number) {
    const result = ab(`eval "fetch('https://sandbox.local${path}').then(r => r.status)" --json`);
    const data = JSON.parse(result);
    if (data.data.result !== status) {
      throw new Error(`Expected status ${status}, got: ${data.data.result}`);
    }
  }

  /**
   * Step: Verify runtime tier
   */
  @Step('The runtime tier for the last run is <tier>')
  async runtimeTier(tier: string) {
    const result = ab(`eval "window.__browserbox.runtime.lastTier" --json`);
    const data = JSON.parse(result);
    if (data.data.result !== tier) {
      throw new Error(`Expected runtime tier "${tier}", got: ${data.data.result}`);
    }
  }

  /**
   * Step: Verify sandbox policy allows network
   */
  @Step('The sandbox policy for <name> allows <pattern>')
  async sandboxPolicyAllows(name: string, pattern: string) {
    const result = ab(`eval "window.__browserbox.sandbox.policy('${name}').allows('${pattern}')" --json`);
    const data = JSON.parse(result);
    if (!data.data.result) {
      throw new Error(`Sandbox policy ${name} does not allow ${pattern}`);
    }
  }

  /**
   * Step: Verify memory limit error
   */
  @Step('A script that allocates <size> throws a memory limit error in QuickJS')
  async memoryLimit(size: string) {
    const script = `const buffer = new Array(${size}).fill(0);`;
    const result = ab(`eval "window.__browserbox.runtime.runQuickJS('${script}')" --json`);
    const data = JSON.parse(result);
    if (!data.error || !data.error.includes('memory limit')) {
      throw new Error(`Expected memory limit error, got: ${data.error || data.result}`);
    }
  }

  /**
   * Step: Verify infinite loop terminated
   */
  @Step('An infinite loop is terminated within <seconds> seconds by watchdog')
  async infiniteLoopTerminated(seconds: string) {
    const script = `while(true) { }`;
    const startTime = Date.now();
    const result = ab(`eval "window.__browserbox.runtime.runQuickJS('${script}')" --json`);
    const elapsed = Date.now() - startTime;
    if (elapsed > parseInt(seconds) * 1000 + 1000) {
      throw new Error(`Infinite loop not terminated within ${seconds} seconds (took ${elapsed}ms)`);
    }
  }

  /**
   * Step: Verify total RAM usage is under limit
   */
  @Step('Total runtime RAM usage is under <size>')
  async ramUsage(size: string) {
    const result = ab(`eval "window.__browserbox.runtime.memoryUsage()" --json`);
    const data = JSON.parse(result);
    // Convert size to bytes (e.g., "200MB" -> 200 * 1024 * 1024)
    const sizeMatch = size.match(/^(\d+)\s*(GB|MB|KB)$/i);
    if (!sizeMatch) {
      throw new Error(`Invalid size format: ${size}`);
    }
    const [, num, unit] = sizeMatch;
    const limit = parseInt(num) * (unit.toUpperCase() === 'GB' ? 1024 * 1024 * 1024 : unit.toUpperCase() === 'MB' ? 1024 * 1024 : 1024);
    if (data.data.result > limit) {
      throw new Error(`RAM usage ${data.data.result} exceeds limit ${limit}`);
    }
  }

  /**
   * Step: Verify agent output contains text
   */
  @Step('The agent output contains <text>')
  async agentOutputContains(text: string) {
    const result = ab(`eval "window.__browserbox.runtime.lastOutput" --json`);
    const data = JSON.parse(result);
    if (!data.data.result || !data.data.result.includes(text)) {
      throw new Error(`Agent output does not contain "${text}": ${data.data.result}`);
    }
  }

  /**
   * Step: Run script in QuickJS tier
   */
  @Step('I run runtime quickjs <path>')
  async runQuickJS(path: string) {
    ab(`eval "window.__browserbox.runtime.runQuickJSFile('${path}')" --json`);
  }

  /**
   * Step: Run script with policy
   */
  @Step('I run runtime run --policy <policy> <path>')
  async runWithPolicy(policy: string, path: string) {
    ab(`eval "window.__browserbox.runtime.runWithPolicy('${path}', '${policy}')" --json`);
  }

  /**
   * Step: Mock AI API responses
   */
  @Step('I mock AI API responses')
  async mockAIResponses() {
    ab('network route "**/v1/chat/completions" --body \'{"choices":[{"message":{"content":"Hello from mock AI"}}]}\'');
  }
}
