import { Step, BeforeSpec, AfterSpec } from 'gauge-ts';
import { ab } from '../lib/ab.js';
import { DEMO_URL } from '../lib/config.js';
import { setupBrowser, teardownBrowser } from '../lib/setup.js';

export class BootApiSteps {
  private lastSpawnExitCode: number | null = null;
  private serverReadyPort: number | null = null;
  private exportedTree: Record<string, unknown> | null = null;

  @BeforeSpec()
  async setup() {
    await setupBrowser();
  }

  @AfterSpec()
  async teardown() {
    await teardownBrowser(() => {
      ab('eval "window.__browserbox.container?.teardown()" --json');
    });
  }

  @Step('I boot a container')
  async bootContainer() {
    ab('eval "window.__browserbox_boot_promise = window.__browserbox.boot({ workdirName: \'/home/web\' })" --json');
    ab('wait --fn "window.__browserbox.container !== undefined" 5000');
  }

  @Step('I boot a container again')
  async bootContainerAgain() {
    ab('eval "window.__browserbox_boot_promise = window.__browserbox.boot({ workdirName: \'/home/web\' })" --json');
    ab('wait --fn "window.__browserbox.container !== undefined" 5000');
  }

  @Step('I mount files <tree>')
  async mountFiles(tree: string) {
    const parsed = JSON.parse(tree);
    const json = JSON.stringify(parsed).replace(/'/g, "\\'");
    ab(`eval "window.__browserbox.container.mount(JSON.parse('${json}'))" --json`);
  }

  @Step('The boot file <path> exists')
  async bootFileExists(path: string) {
    const result = ab(`eval "window.__browserbox.container.fs.exists('${path}')" --json`);
    const data = JSON.parse(result);
    if (!data.data) {
      throw new Error(`File ${path} does not exist`);
    }
  }

  @Step('I spawn <command> in the container')
  async spawnCommand(command: string) {
    const args = command.split(' ').slice(1);
    const cmd = command.split(' ')[0];
    const argsJson = JSON.stringify(args);
    const result = ab(`eval "window.__browserbox_spawn_promise = window.__browserbox.container.spawn('${cmd}', ${argsJson})" --json`);
    const data = JSON.parse(result);
    if (data.error) {
      throw new Error(`Spawn failed: ${data.error}`);
    }
    ab('wait --fn "window.__browserbox_spawn_exit !== undefined" 15000');
    const exitResult = ab('eval "window.__browserbox_spawn_exit" --json');
    const exitData = JSON.parse(exitResult);
    this.lastSpawnExitCode = exitData.data;
  }

  @Step('The spawn exit code is <code>')
  async spawnExitCode(code: string) {
    if (this.lastSpawnExitCode !== parseInt(code)) {
      throw new Error(`Expected exit code ${code}, got ${this.lastSpawnExitCode}`);
    }
  }

  @Step('I listen for server-ready on the container')
  async listenServerReady() {
    ab(`eval "window.__browserbox_server_ready_port = null; window.__browserbox.container.on('server-ready', (port) => { window.__browserbox_server_ready_port = port; })" --json`);
  }

  @Step('A server-ready event is received on port <port>')
  async serverReadyReceived(port: string) {
    ab('wait --fn "window.__browserbox_server_ready_port !== null" 10000');
    const result = ab('eval "window.__browserbox_server_ready_port" --json');
    const data = JSON.parse(result);
    this.serverReadyPort = data.data;
    if (this.serverReadyPort !== parseInt(port)) {
      throw new Error(`Expected port ${port}, got ${this.serverReadyPort}`);
    }
  }

  @Step('I export the container filesystem')
  async exportFilesystem() {
    const result = ab('eval "window.__browserbox_export_promise = window.__browserbox.container.export()" --json');
    ab('wait --fn "window.__browserbox_export_promise !== undefined" 5000');
    const treeResult = ab('eval "window.__browserbox_export_promise" --json');
    const data = JSON.parse(treeResult);
    this.exportedTree = data.data;
  }

  @Step('The exported tree contains file <path> with contents <contents>')
  async exportedTreeHasFile(path: string, contents: string) {
    if (!this.exportedTree) {
      throw new Error('No exported tree available');
    }
    const node = this.exportedTree[path];
    if (!node || typeof node !== 'object' || !('file' in node)) {
      throw new Error(`Expected file ${path} in exported tree`);
    }
    const fileNode = node as { file: { contents: string } };
    if (fileNode.file.contents !== contents) {
      throw new Error(`Expected contents "${contents}", got "${fileNode.file.contents}"`);
    }
  }

  @Step('The exported tree contains directory <path> with file <child> with contents <contents>')
  async exportedTreeHasDirFile(path: string, child: string, contents: string) {
    if (!this.exportedTree) {
      throw new Error('No exported tree available');
    }
    const node = this.exportedTree[path];
    if (!node || typeof node !== 'object' || !('directory' in node)) {
      throw new Error(`Expected directory ${path} in exported tree`);
    }
    const dirNode = node as { directory: Record<string, unknown> };
    const childNode = dirNode.directory[child];
    if (!childNode || typeof childNode !== 'object' || !('file' in childNode)) {
      throw new Error(`Expected file ${child} in directory ${path}`);
    }
    const fileNode = childNode as { file: { contents: string } };
    if (fileNode.file.contents !== contents) {
      throw new Error(`Expected contents "${contents}", got "${fileNode.file.contents}"`);
    }
  }

  @Step('I teardown the container')
  async teardownContainer() {
    ab('eval "window.__browserbox.container.teardown()" --json');
    ab('eval "window.__browserbox.container = undefined" --json');
  }

  @Step('The container is a new instance')
  async newInstance() {
    const result = ab('eval "window.__browserbox.container !== undefined" --json');
    const data = JSON.parse(result);
    if (!data.data) {
      throw new Error('Container is not defined');
    }
  }
}
