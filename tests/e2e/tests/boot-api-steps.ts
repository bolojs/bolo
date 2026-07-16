import { Step } from 'gauge-ts';
import { currentPage } from './hooks';

export default class BootApiSteps {
  private lastSpawnExitCode: number | null = null;
  private serverReadyPort: number | null = null;
  private exportedTree: Record<string, unknown> | null = null;

  @Step('I boot a container')
  async bootContainer() {
    // Wait out the page's own ambient auto-boot first: it also calls
    // window.__browserbox.setContainer() on completion, and racing it would
    // let whichever boot finishes last clobber the other's container.
    await currentPage.waitForSelector('[data-boot-state="ready"]', { timeout: 30000 });
    await currentPage.evaluate(async () => {
      await (window as any).__browserbox.boot({ workdirName: '/home/web' });
    });
  }

  @Step('I boot a container again')
  async bootContainerAgain() {
    await currentPage.evaluate(async () => {
      await (window as any).__browserbox.boot({ workdirName: '/home/web' });
    });
  }

  @Step('I mount files <tree>')
  async mountFiles(tree: string) {
    const parsed = JSON.parse(tree);
    await currentPage.evaluate(
      t => (window as any).__browserbox.container.mount(t),
      parsed,
    );
  }

  @Step('The boot file <path> exists')
  async bootFileExists(path: string) {
    const exists = await currentPage.evaluate(
      p => (window as any).__browserbox.container.fs.exists(p),
      path,
    );
    if (!exists) {
      throw new Error(`File ${path} does not exist`);
    }
  }

  @Step('I spawn <command> in the container')
  async spawnCommand(command: string) {
    const args = command.split(' ').slice(1);
    const cmd = command.split(' ')[0];
    const result = await currentPage.evaluate(
      ([c, a]) => (window as any).__browserbox.container.spawn(c, a),
      [cmd, args] as [string, string[]],
    );
    if ((result as any)?.error) {
      throw new Error(`Spawn failed: ${(result as any).error}`);
    }
    await currentPage.waitForFunction(
      () => (window as any).__browserbox_spawn_exit !== undefined,
      { timeout: 15000 },
    );
    const exit = await currentPage.evaluate(() => (window as any).__browserbox_spawn_exit);
    this.lastSpawnExitCode = exit as number;
  }

  @Step('The spawn exit code is <code>')
  async spawnExitCode(code: string) {
    if (this.lastSpawnExitCode !== parseInt(code)) {
      throw new Error(`Expected exit code ${code}, got ${this.lastSpawnExitCode}`);
    }
  }

  @Step('I listen for server-ready on the container')
  async listenServerReady() {
    await currentPage.evaluate(() => {
      (window as any).__browserbox_server_ready_port = null;
      (window as any).__browserbox.container.on('server-ready', (port: number) => {
        (window as any).__browserbox_server_ready_port = port;
      });
    });
  }

  @Step('A server-ready event is received on port <port>')
  async serverReadyReceived(port: string) {
    await currentPage.waitForFunction(
      () => (window as any).__browserbox_server_ready_port !== null,
      { timeout: 10000 },
    );
    const received = await currentPage.evaluate(() => (window as any).__browserbox_server_ready_port);
    this.serverReadyPort = received as number;
    if (this.serverReadyPort !== parseInt(port)) {
      throw new Error(`Expected port ${port}, got ${this.serverReadyPort}`);
    }
  }

  @Step('I export the container filesystem')
  async exportFilesystem() {
    await currentPage.evaluate(() => {
      (window as any).__browserbox_export_promise = (window as any).__browserbox.container.export();
    });
    await currentPage.waitForFunction(
      () => (window as any).__browserbox_export_promise !== undefined,
      { timeout: 5000 },
    );
    const tree = await currentPage.evaluate(() => (window as any).__browserbox_export_promise);
    this.exportedTree = tree as Record<string, unknown>;
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
    await currentPage.evaluate(() => {
      (window as any).__browserbox.container.teardown();
      (window as any).__browserbox.container = undefined;
    });
  }

  @Step('The container is a new instance')
  async newInstance() {
    const ok = await currentPage.evaluate(() => (window as any).__browserbox.container !== undefined);
    if (!ok) {
      throw new Error('Container is not defined');
    }
  }
}
