import { Step, BeforeSpec, AfterSpec } from 'gauge-ts';
import { ab } from '../lib/ab.js';
import { DEMO_URL } from '../lib/config.js';
import { setupBrowser, teardownBrowser } from '../lib/setup.js';

/**
 * BrowserSteps - Step definitions for browser-containers E2E tests
 * Uses agent-browser CLI to automate browser interactions
 */
export class BrowserSteps {
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
  @Step('The service worker registers successfully')
  async swRegisters() {
    const result = ab('eval "navigator.serviceWorker.controller !== null" --json');
    const data = JSON.parse(result);
    if (!data.data) {
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
    if (data.data !== title) {
      throw new Error(`Expected title "${title}", got "${data.data}"`);
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
    ab(`eval "window.__browserbox.vfs.writeFile('${path}', \`${content}\`)" --json`);
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
    ab(`eval "window.__browserbox.vfs.writeFile('${path}', \`${content}\`)" --json`);
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

export default app;`;
    ab(`eval "window.__browserbox.vfs.writeFile('${path}', \`${content}\`)" --json`);
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
    if (!data.data) {
      throw new Error(`File ${path} does not exist in VFS`);
    }
  }

  /**
   * Step: Verify transform output contains no raw JSX
   */
  @Step('The transform of <path> contains no raw JSX')
  async transformNoJSX(path: string) {
    const result = ab(`eval "window.__browserbox.vite.transform('${path}')" --json`);
    const data = JSON.parse(result);
    if (data.data && (data.data.includes('<') || data.data.includes('>'))) {
      throw new Error(`Transform output contains raw JSX: ${data.data}`);
    }
  }

  /**
   * Step: Verify preview iframe contains text
   */
  @Step('The preview iframe shows <text>')
  async previewShows(text: string) {
    ab('frame "iframe[data-preview]"');
    ab(`wait --text "${text}" 15000`);
    ab('frame main');
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
    if (!data.data.includes('blocked')) {
      throw new Error(`Request to ${url} was not blocked: ${data.data}`);
    }
  }

  /**
   * Step: Verify sandbox origin request returns expected text
   */
  @Step('A request to the sandbox origin <path> returns <text>')
  async sandboxRequest(path: string, text: string) {
    const result = ab(`eval "fetch('https://sandbox.local${path}').then(r => r.text())" --json`);
    const data = JSON.parse(result);
    if (!data.data || !data.data.includes(text)) {
      throw new Error(`Expected response to contain "${text}", got: ${data.data}`);
    }
  }

  /**
   * Step: Verify sandbox origin request returns status
   */
  @Step('A request to the sandbox origin <path> returns status <status>')
  async sandboxRequestStatus(path: string, status: number) {
    const result = ab(`eval "fetch('https://sandbox.local${path}').then(r => r.status)" --json`);
    const data = JSON.parse(result);
    if (data.data !== status) {
      throw new Error(`Expected status ${status}, got: ${data.data}`);
    }
  }

  /**
   * Step: Verify runtime tier
   */
  @Step('The runtime tier for the last run is <tier>')
  async runtimeTier(tier: string) {
    const result = ab(`eval "window.__browserbox.runtime.lastTier" --json`);
    const data = JSON.parse(result);
    if (data.data !== tier) {
      throw new Error(`Expected runtime tier "${tier}", got: ${data.data}`);
    }
  }

  /**
   * Step: Verify sandbox policy allows network
   */
  @Step('The sandbox policy for <name> allows <pattern>')
  async sandboxPolicyAllows(name: string, pattern: string) {
    const result = ab(`eval "window.__browserbox.sandbox.policy('${name}').allows('${pattern}')" --json`);
    const data = JSON.parse(result);
    if (!data.data) {
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
    if (data.data > limit) {
      throw new Error(`RAM usage ${data.data} exceeds limit ${limit}`);
    }
  }

  /**
   * Step: Verify agent output contains text
   */
  @Step('The agent output contains <text>')
  async agentOutputContains(text: string) {
    const result = ab(`eval "window.__browserbox.runtime.lastOutput" --json`);
    const data = JSON.parse(result);
    if (!data.data || !data.data.includes(text)) {
      throw new Error(`Agent output does not contain "${text}": ${data.data}`);
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
